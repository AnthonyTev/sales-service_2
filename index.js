import express from "express";
import session from "express-session";
import fetch from "node-fetch";
import path from "path";
import { fileURLToPath } from "url";
import { WebSocketServer } from "ws";
import http from "http";
import pool from "./db.js";

const INVENTORY_SERVICE_URL = "http://localhost:5145/api/inventory";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const app = express();
const server = http.createServer(app);
const wss = new WebSocketServer({ server });

// ---------------- WebSocket (Sales updates) ----------------
const clients = new Set();

wss.on("connection", (ws) => {
  console.log("New Sales WebSocket client connected");
  clients.add(ws);

  ws.on("close", () => clients.delete(ws));
  ws.on("error", () => clients.delete(ws));
});

function broadcast(data) {
  const message = JSON.stringify(data);
  clients.forEach((client) => {
    if (client.readyState === 1) client.send(message);
  });
}

app.use(express.json());
app.use(express.urlencoded({ extended: true }));

app.use((req, res, next) => {
  res.setHeader(
    "Content-Security-Policy",
    "default-src 'self'; " +
      "script-src 'self' 'unsafe-inline' https://cdnjs.cloudflare.com; " +
      "style-src 'self' 'unsafe-inline'; " +
      "img-src 'self' data: https:; " +
      "connect-src 'self' http://localhost:3001 ws://localhost:3001 http://localhost:5145 ws://localhost:5145;"
  );
  next();
});

const sessionMiddleware = session({
  secret: "sales-secret",
  resave: false,
  saveUninitialized: true,
});

app.use(sessionMiddleware);
app.use(express.static(path.join(__dirname, "public")));

const INVENTORY_API = "http://localhost:5145/api/inventory";

//auth
app.get("/", (req, res) => res.redirect("/login.html"));

app.post("/login", (req, res) => {
  const { username, password } = req.body;
  if (username === "user" && password === "pass123") {
    req.session.user = username;
    return res.json({ success: true });
  }
  res.json({ success: false });
});

app.post("/logout", (req, res) => {
  req.session.destroy(() => res.json({ success: true }));
});

app.get("/products", async (req, res) => {
  if (!req.session.user)
    return res.status(401).json({ error: "Unauthorized" });

  try {
    const inventoryRes = await fetch(INVENTORY_API);
    if (!inventoryRes.ok) throw new Error("Inventory fetch failed");

    const products = await inventoryRes.json();

    const mapped = products.map((p) => ({
      id: p.id,
      name: p.name,
      price: p.price,
      // FIX: Check for 'Qty' (database) OR 'qty' OR 'quantity' and default to 0
      quantity: p.Qty ?? p.qty ?? p.quantity ?? 0, 
      image: p.uri || "/images/default.jpg",
    }));

    res.json(mapped);
  } catch (err) {
    console.error("Error fetching products:", err.message);
    res.status(500).json({ error: "Failed to load products." });
  }
});

// ---------------- Cart ----------------
app.post("/cart/add", (req, res) => {
  if (!req.session.user)
    return res.status(401).json({ error: "Unauthorized" });

  const { id, qty } = req.body;
  if (!req.session.cart) req.session.cart = [];
  req.session.cart.push({ id, qty });
  res.json({ success: true });
});

app.get("/cart", async (req, res) => {
  if (!req.session.user)
    return res.status(401).json({ error: "Unauthorized" });

  const cart = req.session.cart || [];
  if (!cart.length) return res.json([]);

  const inventoryRes = await fetch(INVENTORY_API);
  const products = await inventoryRes.json();

  const detailed = cart.map((c) => {
    const p = products.find((p) => p.id === c.id);
    return {
      id: c.id,
      name: p?.name ?? "Unknown",
      price: Number(p?.price ?? 0),
      qty: c.qty,
      total: Number(p?.price ?? 0) * c.qty,
    };
  });

  res.json(detailed);
});

app.post("/checkout", async (req, res) => {
  const username = req.session.user;
  const cartItems = req.session.cart;

  if (!username) return res.status(401).json({ success: false, message: "Unauthorized" });
  if (!cartItems || cartItems.length === 0) {
    return res.status(400).json({ success: false, message: "Cart is empty" });
  }

  try {
    let totalAmount = 0;
    
    // 1. Process items
    const enrichedItems = await Promise.all(cartItems.map(async (item) => {
        const productUrl = `${INVENTORY_SERVICE_URL}/${item.id}`;
        
        // A. Fetch current product details
        const response = await fetch(productUrl);
        if (!response.ok) throw new Error(`Product ${item.id} not found in inventory`);
        
        const productData = await response.json();
        
        // --- DEBUG LOGGING: See exactly what the Inventory sends ---
        console.log(`Checking stock for ${item.id}:`, productData);

        // --- ROBUST FIX: Check all common casing variations ---
        // This handles 'Qty', 'qty', or 'quantity' automatically
        const currentStock = productData.Qty ?? productData.qty ?? productData.quantity ?? 0;
        
        // Use lowercase 'qty' for the cart item (this comes from your session)
        const requestedQty = item.qty; 

        // B. Check stock
        if (currentStock < requestedQty) {
            throw new Error(`Not enough stock for ${productData.name}. (Has: ${currentStock}, Needs: ${requestedQty})`);
        }

        // C. Calculate new quantity
        const newStock = currentStock - requestedQty;

        // D. UPDATE INVENTORY
        // We send back the exact object we received, but with the updated quantity property.
        // We explicitly update 'Qty' because you confirmed the DB expects that.
        const updateBody = { ...productData };
        
        // Ensure we update the correct field name that holds the data
        if (productData.hasOwnProperty('Qty')) updateBody.Qty = newStock;
        else if (productData.hasOwnProperty('qty')) updateBody.qty = newStock;
        else if (productData.hasOwnProperty('quantity')) updateBody.quantity = newStock;
        else updateBody.Qty = newStock; // Default fallback

        await fetch(productUrl, {
            method: "PUT",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify(updateBody)
        });

        // E. Add to total for Sales DB
        totalAmount += productData.price * requestedQty;
        
        return {
            product_id: item.id,
            quantity: requestedQty,
            price: productData.price
        };
    }));

    // 2. Insert into 'sales' table
    const saleResult = await pool.query(
      "INSERT INTO sales (username, total_amount) VALUES ($1, $2) RETURNING id",
      [username, totalAmount]
    );
    const saleId = saleResult.rows[0].id;

    // 3. Insert into 'sale_items' table
    for (const item of enrichedItems) {
      await pool.query(
        "INSERT INTO sale_items (sale_id, product_id, quantity) VALUES ($1, $2, $3)",
        [saleId, item.product_id, item.quantity]
      );
    }

    // 4. CLEAR CART
    req.session.cart = [];

    // 5. Success Response
    res.json({ success: true, message: "Sale successful", saleId, totalAmount });
    
    broadcast({ type: "new_sale", data: { username, totalAmount } });

  } catch (error) {
    console.error("Checkout Error:", error);
    res.status(500).json({ success: false, message: error.message });
  }
});

app.get("/sales", async (req, res) => {
  try {
    const result = await pool.query("SELECT * FROM sales_summary");
    const flatData = result.rows;

    // 1. Fetch details for all items
    const enrichedData = await Promise.all(flatData.map(async (row) => {
        try {
            const response = await fetch(`${INVENTORY_SERVICE_URL}/${row.product_id}`);
            const product = await response.json();
            return { ...row, product_name: product.name, price: product.price };
        } catch (e) {
            return { ...row, product_name: "Unknown", price: 0 };
        }
    }));

    // 2. Group items by Sale ID
    const salesMap = {};
    enrichedData.forEach((row) => {
        if (!salesMap[row.sale_id]) {
            salesMap[row.sale_id] = {
                id: row.sale_id,
                username: row.username,
                total_amount: row.total_amount,
                sale_date: row.sale_date,
                items: []
            };
        }
        if (row.product_id) { // Check if there are items
            salesMap[row.sale_id].items.push({
                product_name: row.product_name,
                quantity: row.quantity,
                subtotal: row.price * row.quantity 
            });
        }
    });

    // 3. Convert back to array
    const groupedSales = Object.values(salesMap);
    
    res.json(groupedSales);
  } catch (error) {
    console.error(error);
    res.status(500).send("Server Error");
  }
});

// ---------------- Start server ----------------
server.listen(3001, () =>
  console.log("Sales Service running on http://localhost:3001")
);
