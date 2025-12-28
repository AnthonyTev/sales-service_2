let ws;

function connectWebSocket() {
  ws = new WebSocket("ws://localhost:3001");

  ws.onopen = () => {
    console.log("Sales WebSocket connected");
    showNotification("Connected to sales updates", "success");
  };

  ws.onmessage = (event) => {
    const data = JSON.parse(event.data);
    handleWebSocketMessage(data);
  };

  ws.onerror = (error) => {
    console.error("Sales WebSocket error:", error);
  };

  ws.onclose = () => {
    console.log("Sales WebSocket disconnected, reconnecting...");
    setTimeout(connectWebSocket, 3000);
  };
}

function handleWebSocketMessage(data) {
  if (data.type === "new_sale") {
    showNotification(
      `New sale: ${data.data.username} - ₱${data.data.totalAmount.toFixed(2)}`,
      "info"
    );
    loadProducts();
    loadSalesHistory();
  }
}

// ---------- SignalR (Inventory updates) ----------
let inventoryConnection;

function connectInventorySignalR() {
  inventoryConnection = new signalR.HubConnectionBuilder()
    .withUrl("http://localhost:5145/hubs/notifications")
    .withAutomaticReconnect()
    .build();

  inventoryConnection.on("ReceiveNotification", (message) => {
    console.log("Inventory update:", message);
    showNotification("Inventory updated", "info");
    loadProducts(); // 🔥 auto refresh products
  });

  inventoryConnection
    .start()
    .then(() => console.log("Connected to Inventory SignalR"))
    .catch((err) => console.error("SignalR error:", err));
}

// ---------- Notifications ----------
function showNotification(message, type = "info") {
  const notif = document.createElement("div");
  notif.style.cssText = `
    position: fixed;
    top: 20px;
    right: 20px;
    padding: 15px 20px;
    background: ${
      type === "success"
        ? "#2ecc71"
        : type === "error"
        ? "#e74c3c"
        : "#3498db"
    };
    color: white;
    border-radius: 8px;
    box-shadow: 0 4px 6px rgba(0,0,0,0.2);
    z-index: 1000;
    animation: slideIn 0.3s ease-out;
  `;
  notif.textContent = message;
  document.body.appendChild(notif);

  setTimeout(() => {
    notif.style.animation = "slideOut 0.3s ease-out";
    setTimeout(() => notif.remove(), 300);
  }, 3000);
}

// ---------- Products ----------
async function loadProducts() {
  const res = await fetch("/products");
  if (res.status === 401) {
    window.location.href = "login.html";
    return;
  }

  const products = await res.json();
  const list = document.getElementById("productList");
  list.innerHTML = "";

  products.forEach((p) => {
    const li = document.createElement("li");
    li.innerHTML = `
      <div style="text-align:left; display:flex; gap:10px; align-items:center;">
        <img 
          src="${p.image}" 
          alt="${p.name}"
          style="width:80px;height:80px;border-radius:8px;object-fit:cover;"
        >
        <div>
          <strong>${p.name}</strong><br>
          ₱${p.price}<br>
          <small>Available: ${p.quantity}</small>
        </div>
      </div>
      <button onclick="addToCart(${p.id})" ${
        p.quantity <= 0 ? "disabled" : ""
      }>
        ${p.quantity <= 0 ? "Out of Stock" : "Add"}
      </button>
    `;
    list.appendChild(li);
  });

  loadCart();
}

// ---------- Cart ----------
async function addToCart(id) {
  await fetch("/cart/add", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ id, qty: 1 }),
  });
  showNotification("Added to cart", "success");
  loadCart();
}

async function loadCart() {
  const res = await fetch("/cart");
  if (res.status === 401) return;

  const cart = await res.json();
  const list = document.getElementById("cartList");
  list.innerHTML = "";

  let grandTotal = 0;

  cart.forEach((c) => {
    const li = document.createElement("li");
    li.textContent = `${c.name} (₱${c.price}) x ${c.qty} = ₱${c.total}`;
    list.appendChild(li);
    grandTotal += c.total;
  });

  if (cart.length > 0) {
    const totalLi = document.createElement("li");
    totalLi.innerHTML = `<strong>Total: ₱${grandTotal.toFixed(2)}</strong>`;
    list.appendChild(totalLi);
  }
}

// ---------- Checkout ----------
async function checkout() {
  const res = await fetch("/checkout", { method: "POST" });
  const data = await res.json();

  if (data.success) {
    showNotification(data.message, "success");
    loadProducts();
    loadCart();
    loadSalesHistory();
  } else {
    showNotification(data.message || "Checkout failed", "error");
  }
}

// ---------- Logout ----------
async function logout() {
  if (ws) ws.close();
  if (inventoryConnection) inventoryConnection.stop();

  await fetch("/logout", { method: "POST" });
  window.location.href = "login.html";
}

// ---------- Sales History ----------
async function loadSalesHistory() {
  const res = await fetch("/sales");
  if (res.status === 401) return;

  const sales = await res.json();
  const container = document.getElementById("salesHistory");
  if (!container) return;

  container.innerHTML = "<h3>Recent Sales</h3>";

  sales.forEach((sale) => {
    const saleDiv = document.createElement("div");
    saleDiv.style.cssText = `
      background: white;
      padding: 15px;
      margin: 10px 0;
      border-radius: 8px;
      border: 1px solid #ddd;
    `;

    const itemsList = sale.items
      .map(
        (item) =>
          `• ${item.product_name} x${item.quantity} = ₱${parseFloat(
            item.subtotal
          ).toFixed(2)}`
      )
      .join("<br>");

    saleDiv.innerHTML = `
      <strong>Sale #${sale.id}</strong> - ${sale.username}<br>
      <small>${new Date(sale.sale_date).toLocaleString()}</small><br>
      <div style="margin-top:10px">${itemsList}</div>
      <div style="margin-top:10px"><strong>Total: ₱${parseFloat(
        sale.total_amount
      ).toFixed(2)}</strong></div>
    `;

    container.appendChild(saleDiv);
  });
}

// ---------- Animations ----------
const style = document.createElement("style");
style.textContent = `
@keyframes slideIn {
  from { transform: translateX(100%); opacity: 0; }
  to { transform: translateX(0); opacity: 1; }
}
@keyframes slideOut {
  from { transform: translateX(0); opacity: 1; }
  to { transform: translateX(100%); opacity: 0; }
}`;
document.head.appendChild(style);

// ---------- On Load ----------
window.onload = () => {
  loadProducts();
  connectWebSocket();
  connectInventorySignalR(); // 🔥 THIS IS THE KEY
  loadSalesHistory();
};