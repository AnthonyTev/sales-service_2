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

// ---------------- Middleware ----------------
app.use(express.json());
app.use(express.urlencoded({ extended: true }));

// 🔥 FIXED CSP (SignalR + Cloudinary + WebSockets allowed)
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

    // 🔥 USE INVENTORY IMAGE (uri)
    const mapped = products.map((p) => ({
      id: p.id,
      name: p.name,
      price: p.price,
      quantity: p.qty ?? 0,
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
    res.status(500).json({ error: "Checkout failed." });
  } finally {
    client.release();
  }
});

// ---------------- Start server ----------------
server.listen(3001, () =>
  console.log("Sales Service running on http://localhost:3001")
);
