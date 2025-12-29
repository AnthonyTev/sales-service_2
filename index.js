import express from "express";
import session from "express-session";
import fetch from "node-fetch";
import path from "path";
import { fileURLToPath } from "url";
import { WebSocket } from "ws"; // Import WebSocket client
import { WebSocketServer } from "ws";
import http from "http";
import pool from "./db.js";

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

// ---------------- Connect to C# Inventory WebSocket ----------------
let inventoryWs = null;
const INVENTORY_WS_URL = "ws://localhost:5145/hubs/notifications";

function connectToInventoryWebSocket() {
  try {
    inventoryWs = new WebSocket(INVENTORY_WS_URL);

    // Use event listeners correctly for ws library
    inventoryWs.addEventListener("open", () => {
      console.log("Connected to C# Inventory WebSocket Hub");
      
      // Send SignalR handshake/negotiation
      const handshake = JSON.stringify({
        protocol: "json",
        version: 1
      });
      inventoryWs.send(handshake);
    });

    inventoryWs.addEventListener("message", (event) => {
      try {
        const message = event.data.toString();
        console.log("Raw inventory message:", message);
        
        // Skip empty messages or keep-alive messages
        if (!message || message === "{}" || /^\d+$/.test(message)) {
          return;
        }
        
        // Try to parse as JSON
        try {
          const parsed = JSON.parse(message);
          
          // Handle different SignalR message types
          if (parsed.type === 1 && parsed.target === "InventoryUpdated") {
            console.log("Inventory update received:", parsed.arguments);
            
            // Forward to all sales WebSocket clients
            broadcast({
              type: "inventory_update",
              action: parsed.arguments[0], // "Product added", "Product updated", etc.
              data: parsed.arguments[1]    // The product data
            });
          } else if (parsed.type === 1 && parsed.target === "ReceiveNotification") {
            // Handle notification messages
            console.log("Notification received:", parsed.arguments[0]);
            
            // Just forward a refresh message
            broadcast({
              type: "inventory_refresh",
              message: parsed.arguments[0]
            });
          }
        } catch (parseError) {
          console.error("Failed to parse WebSocket message:", parseError.message);
        }
      } catch (err) {
        console.error("Error processing inventory message:", err.message);
      }
    });

    inventoryWs.addEventListener("close", () => {
      console.log("Disconnected from C# Inventory WebSocket, reconnecting in 5s...");
      setTimeout(connectToInventoryWebSocket, 5000);
    });

    inventoryWs.addEventListener("error", (err) => {
      console.error("Inventory WebSocket error:", err.message);
    });
  } catch (err) {
    console.error("Failed to create WebSocket connection:", err.message);
    setTimeout(connectToInventoryWebSocket, 5000);
  }
}

// ---------------- Alternative: HTTP polling fallback ----------------
const POLL_INTERVAL = 3000; // 3 seconds

async function pollInventoryChanges() {
  try {
    const response = await fetch("http://localhost:5145/api/inventory");
    if (response.ok) {
      const products = await response.json();
      
      // Broadcast a refresh signal
      broadcast({
        type: "inventory_refresh",
        timestamp: Date.now()
      });
    }
  } catch (err) {
    console.error("Polling failed:", err.message);
  }
}

// ---------------- Middleware ----------------
app.use(express.json());
app.use(express.urlencoded({ extended: true }));

// Updated CSP to allow WebSocket connections
app.use((req, res, next) => {
  res.setHeader(
    "Content-Security-Policy",
    "default-src 'self'; " +
      "script-src 'self' 'unsafe-inline' https://cdnjs.cloudflare.com; " +
      "style-src 'self' 'unsafe-inline'; " +
      "img-src 'self' data: https:; " +
      "connect-src 'self' http://localhost:3001 ws://localhost:3001 " +
      "http://localhost:5145 ws://localhost:5145 ws://localhost:5145/hubs/notifications;"
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

// ---------------- Auth ----------------
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

// ---------------- Products ----------------
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
      quantity: p.qty ?? 0,
      image: p.uri || "/images/default.jpg",
      status: p.status
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
      available: p?.qty ?? 0
    };
  });

  res.json(detailed);
});

// ---------------- Checkout ----------------
app.post("/checkout", async (req, res) => {
  if (!req.session.user)
    return res.status(401).json({ error: "Unauthorized" });

  const cart = req.session.cart || [];
  if (!cart.length)
    return res.json({ success: false, message: "Cart is empty." });

  const client = await pool.connect();

  try {
    await client.query("BEGIN");

    const inventoryRes = await fetch(INVENTORY_API);
    const products = await inventoryRes.json();

    let totalAmount = 0;
    const saleItems = cart.map((item) => {
      const p = products.find((p) => p.id === item.id);
      const subtotal = Number(p.price) * item.qty;
      totalAmount += subtotal;
      return {
        product_id: item.id,
        product_name: p.name,
        price: p.price,
        quantity: item.qty,
        subtotal,
      };
    });

    const saleResult = await client.query(
      "INSERT INTO sales (username, total_amount) VALUES ($1, $2) RETURNING id",
      [req.session.user, totalAmount]
    );

    const saleId = saleResult.rows[0].id;

    for (const item of saleItems) {
      await client.query(
        "INSERT INTO sale_items (sale_id, product_id, product_name, price, quantity, subtotal) VALUES ($1,$2,$3,$4,$5,$6)",
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

    for (const item of cart) {
      await fetch(
        `${INVENTORY_API}/${item.id}/adjust-qty?delta=${-item.qty}`,
        { method: "PATCH" }
      );
    }

    await client.query("COMMIT");
    req.session.cart = [];

    broadcast({
      type: "new_sale",
      data: { saleId, totalAmount },
    });

    res.json({
      success: true,
      message: `Checkout successful! Total: ₱${totalAmount.toFixed(2)}`,
    });
  } catch (err) {
    await client.query("ROLLBACK");
    console.error("Checkout error:", err);
    res.status(500).json({ error: "Checkout failed." });
  } finally {
    client.release();
  }
});

// ---------------- Sales History ----------------
app.get("/sales", async (req, res) => {
  if (!req.session.user)
    return res.status(401).json({ error: "Unauthorized" });

  try {
    const salesRes = await pool.query(
      "SELECT * FROM sales ORDER BY sale_date DESC LIMIT 10"
    );
    const sales = salesRes.rows;

    for (const sale of sales) {
      const itemsRes = await pool.query(
        "SELECT * FROM sale_items WHERE sale_id = $1",
        [sale.id]
      );
      sale.items = itemsRes.rows;
    }

    res.json(sales);
  } catch (err) {
    console.error("Error fetching sales history:", err.message);
    res.status(500).json({ error: "Failed to load sales history." });
  }
});

// ---------------- WebSocket message handler for clients ----------------
wss.on("connection", (ws) => {
  console.log("New Sales WebSocket client connected");
  clients.add(ws);

  ws.on("message", (message) => {
    try {
      const data = JSON.parse(message);
      
      if (data.type === "subscribe_inventory") {
        // Send current inventory status to new subscriber
        fetch(INVENTORY_API)
          .then(res => res.json())
          .then(products => {
            ws.send(JSON.stringify({
              type: "inventory_snapshot",
              data: products
            }));
          })
          .catch(err => console.error("Failed to send snapshot:", err));
      }
    } catch (err) {
      console.error("WebSocket message error:", err);
    }
  });

  ws.on("close", () => clients.delete(ws));
  ws.on("error", (err) => {
    console.error("Client WebSocket error:", err);
    clients.delete(ws);
  });
});

// ---------------- Start server and connect to C# ----------------
server.listen(3001, () => {
  console.log("Sales Service running on http://localhost:3001");
  
  // Connect to C# inventory WebSocket
  connectToInventoryWebSocket();
  
  // Start polling as fallback
  setInterval(pollInventoryChanges, POLL_INTERVAL);
});