import express from "express";
import session from "express-session";
import fetch from "node-fetch";
import path from "path";
import { fileURLToPath } from "url";
import { WebSocketServer } from "ws";
import http from "http";
import pool from "./db.js";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const app = express();
const server = http.createServer(app);
const wss = new WebSocketServer({ server });

// Store connected clients
const clients = new Set();

// WebSocket connection handler
wss.on("connection", (ws) => {
  console.log("New WebSocket client connected");
  clients.add(ws);

  ws.on("close", () => {
    console.log("Client disconnected");
    clients.delete(ws);
  });

  ws.on("error", (error) => {
    console.error("WebSocket error:", error);
    clients.delete(ws);
  });
});

// Broadcast function to send updates to all clients
function broadcast(data) {
  const message = JSON.stringify(data);
  clients.forEach((client) => {
    if (client.readyState === 1) { // 1 = OPEN
      client.send(message);
    }
  });
}

app.use(express.json());
app.use(express.urlencoded({ extended: true }));

app.use((req, res, next) => {
  res.setHeader(
    "Content-Security-Policy",
    "default-src 'self'; script-src 'self' 'unsafe-inline'; style-src 'self' 'unsafe-inline'; img-src 'self' data:; connect-src 'self' http://localhost:3001 ws://localhost:3001 http://localhost:5145;"
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

app.get("/", (req, res) => {
  res.redirect("/login.html");
});

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
    const inventoryRes = await fetch(`${INVENTORY_API}`);
    if (!inventoryRes.ok) throw new Error("Failed to fetch inventory data");

    let products = await inventoryRes.json();

    products = products.map((p) => {
      let image = "/images/default.jpg";

      if (p.name.toLowerCase().includes("pen")) image = "/images/pen.jpg";
      else if (p.name.toLowerCase().includes("notebook"))
        image = "/images/notebook.jpg";
      else if (p.name.toLowerCase().includes("paper"))
        image = "/images/paper.jpg";

      return {
        ...p,
        quantity: p.quantity || 25,
        image,
      };
    });

    res.json(products);
  } catch (err) {
    console.error("Error fetching products:", err.message);
    res.status(500).json({ error: "Failed to load products." });
  }
});

app.post("/cart/add", (req, res) => {
  if (!req.session.user)
    return res.status(401).json({ error: "Unauthorized" });

  const { id, qty } = req.body;
  if (!req.session.cart) req.session.cart = [];
  req.session.cart.push({ id, qty });
  res.json({ success: true, cart: req.session.cart });
});

app.get("/cart", async (req, res) => {
  if (!req.session.user)
    return res.status(401).json({ error: "Unauthorized" });

  const cart = req.session.cart || [];
  if (cart.length === 0) return res.json([]);

  try {
    const inventoryRes = await fetch(`${INVENTORY_API}`);
    const products = await inventoryRes.json();

    const detailedCart = cart.map((c) => {
      const product = products.find((p) => p.id === c.id);
      return {
        id: c.id,
        name: product?.name || "Unknown",
        price: Number(product?.price || 0),
        qty: c.qty,
        total: Number(product?.price || 0) * c.qty,
      };
    });

    res.json(detailedCart);
  } catch (err) {
    console.error("Error loading cart:", err.message);
    res.status(500).json({ error: "Failed to load cart." });
  }
});

app.post("/checkout", async (req, res) => {
  if (!req.session.user)
    return res.status(401).json({ error: "Unauthorized" });

  const cart = req.session.cart || [];
  if (cart.length === 0)
    return res.json({ success: false, message: "Cart is empty." });

  const client = await pool.connect();

  try {
    await client.query("BEGIN");

    // Fetch product details from inventory
    const inventoryRes = await fetch(`${INVENTORY_API}`);
    const products = await inventoryRes.json();

    // Calculate total amount
    let totalAmount = 0;
    const saleItems = cart.map((item) => {
      const product = products.find((p) => p.id === item.id);
      const subtotal = Number(product?.price || 0) * item.qty;
      totalAmount += subtotal;
      return {
        product_id: item.id,
        product_name: product?.name || "Unknown",
        price: Number(product?.price || 0),
        quantity: item.qty,
        subtotal: subtotal,
      };
    });

    // Insert sale record
    const saleResult = await client.query(
      "INSERT INTO sales (username, total_amount) VALUES ($1, $2) RETURNING id",
      [req.session.user, totalAmount]
    );
    const saleId = saleResult.rows[0].id;

    // Insert sale items
    for (const item of saleItems) {
      await client.query(
        "INSERT INTO sale_items (sale_id, product_id, product_name, price, quantity, subtotal) VALUES ($1, $2, $3, $4, $5, $6)",
        [
          saleId,
          item.product_id,
          item.product_name,
          item.price,
          item.quantity,
          item.subtotal,
        ]
      );
    }

    // Update inventory for each product
    for (const item of cart) {
      await fetch(
        `${INVENTORY_API}/${item.id}/adjust-qty?delta=${-item.qty}`,
        { method: "PATCH" }
      );
    }

    await client.query("COMMIT");

    // Clear cart
    req.session.cart = [];

    // Broadcast to all connected clients
    broadcast({
      type: "new_sale",
      data: {
        saleId,
        username: req.session.user,
        totalAmount,
        items: saleItems,
        timestamp: new Date().toISOString(),
      },
    });

    res.json({
      success: true,
      message: `Checkout successful! Total: ₱${totalAmount.toFixed(2)}`,
      saleId,
    });
  } catch (err) {
    await client.query("ROLLBACK");
    console.error("Checkout error:", err.message);
    res.status(500).json({ error: "Checkout failed. Try again later." });
  } finally {
    client.release();
  }
});

// NEW: Get sales history
app.get("/sales", async (req, res) => {
  if (!req.session.user)
    return res.status(401).json({ error: "Unauthorized" });

  try {
    const result = await pool.query(
      `SELECT s.id, s.username, s.total_amount, s.sale_date,
              json_agg(
                json_build_object(
                  'product_name', si.product_name,
                  'price', si.price,
                  'quantity', si.quantity,
                  'subtotal', si.subtotal
                )
              ) as items
       FROM sales s
       LEFT JOIN sale_items si ON s.id = si.sale_id
       GROUP BY s.id
       ORDER BY s.sale_date DESC
       LIMIT 20`
    );

    res.json(result.rows);
  } catch (err) {
    console.error("Error fetching sales:", err.message);
    res.status(500).json({ error: "Failed to load sales history." });
  }
});

// NEW: Get sales statistics
app.get("/sales/stats", async (req, res) => {
  if (!req.session.user)
    return res.status(401).json({ error: "Unauthorized" });

  try {
    const result = await pool.query(`
      SELECT 
        COUNT(*) as total_sales,
        COALESCE(SUM(total_amount), 0) as total_revenue,
        COALESCE(AVG(total_amount), 0) as avg_sale_amount,
        COUNT(DISTINCT username) as unique_customers
      FROM sales
    `);

    res.json(result.rows[0]);
  } catch (err) {
    console.error("Error fetching stats:", err.message);
    res.status(500).json({ error: "Failed to load statistics." });
  }
});

server.listen(3001, () =>
  console.log("Sales Service running on http://localhost:3001")
);