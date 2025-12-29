let ws;

function connectWebSocket() {
  ws = new WebSocket("ws://localhost:3001");

  ws.onopen = () => {
    console.log("Sales WebSocket connected");
    showNotification("Connected to real-time updates", "success");
    // Request initial inventory snapshot
    ws.send(JSON.stringify({ type: "subscribe_inventory" }));
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
  console.log("WebSocket message:", data);
  
  switch(data.type) {
    case "new_sale":
      showNotification(
        `New sale: ₱${data.data.totalAmount.toFixed(2)}`,
        "info"
      );
      loadSalesHistory();
      break;
      
    case "inventory_update":
      handleInventoryUpdate(data.action, data.data);
      break;
      
    case "inventory_refresh":
      // Full refresh of products
      loadProducts();
      break;
      
    case "inventory_snapshot":
      // Initial load of products
      renderProducts(data.data);
      break;
  }
}

// ---------- Handle real-time inventory updates ----------
function handleInventoryUpdate(action, product) {
  console.log(`Inventory ${action}:`, product);
  
  switch(action) {
    case "Product added":
      addProductToUI(product);
      showNotification(`"${product.name}" added`, "success");
      break;
      
    case "Product updated":
      updateProductInUI(product);
      showNotification(`"${product.name}" updated`, "info");
      break;
      
    case "Product deleted":
      removeProductFromUI(product.id);
      showNotification(`"${product.name}" deleted`, "error");
      break;
      
    case "Product quantity adjusted":
      updateProductQuantity(product.id, product.qty);
      showNotification(`"${product.name}" quantity: ${product.qty}`, "info");
      break;
  }
}

// ---------- Helper functions to update UI without full refresh ----------
function addProductToUI(product) {
  const list = document.getElementById("productList");
  if (!list) return;
  
  const li = document.createElement("li");
  li.innerHTML = createProductHTML(product);
  list.appendChild(li);
}

function updateProductInUI(product) {
  const list = document.getElementById("productList");
  if (!list) return;
  
  // Find existing product
  const items = list.getElementsByTagName("li");
  for (let item of items) {
    const button = item.querySelector("button");
    if (button && button.onclick && button.onclick.toString().includes(`addToCart(${product.id})`)) {
      // Update the entire product element
      item.innerHTML = createProductHTML(product);
      break;
    }
  }
}

function removeProductFromUI(productId) {
  const list = document.getElementById("productList");
  if (!list) return;
  
  const items = list.getElementsByTagName("li");
  for (let i = 0; i < items.length; i++) {
    const button = items[i].querySelector("button");
    if (button && button.onclick && button.onclick.toString().includes(`addToCart(${productId})`)) {
      list.removeChild(items[i]);
      break;
    }
  }
}

function updateProductQuantity(productId, newQty) {
  const list = document.getElementById("productList");
  if (!list) return;
  
  const items = list.getElementsByTagName("li");
  for (let item of items) {
    const button = item.querySelector("button");
    if (button && button.onclick && button.onclick.toString().includes(`addToCart(${productId})`)) {
      // Update quantity text
      const qtyElement = item.querySelector("small");
      if (qtyElement) {
        qtyElement.textContent = `Available: ${newQty}`;
      }
      
      // Update button state
      button.disabled = newQty <= 0;
      button.textContent = newQty <= 0 ? "Out of Stock" : "Add";
      break;
    }
  }
}

function createProductHTML(p) {
  const product = {
    id: p.id,
    name: p.name,
    price: p.price,
    quantity: p.qty || p.quantity || 0,
    image: p.uri || p.image || "/images/default.jpg"
  };
  
  return `
    <div style="text-align:left; display:flex; gap:10px; align-items:center;">
      <img 
        src="${product.image}" 
        alt="${product.name}"
        style="width:80px;height:80px;border-radius:8px;object-fit:cover;"
      >
      <div>
        <strong>${product.name}</strong><br>
        ₱${product.price}<br>
        <small>Available: ${product.quantity}</small>
      </div>
    </div>
    <button onclick="addToCart(${product.id})" ${product.quantity <= 0 ? "disabled" : ""}>
      ${product.quantity <= 0 ? "Out of Stock" : "Add"}
    </button>
  `;
}

// ---------- Products ----------
async function loadProducts() {
  const res = await fetch("/products");
  if (res.status === 401) {
    window.location.href = "login.html";
    return;
  }

  const products = await res.json();
  renderProducts(products);
}

function renderProducts(products) {
  const list = document.getElementById("productList");
  if (!list) return;
  
  list.innerHTML = "";

  products.forEach((p) => {
    const li = document.createElement("li");
    li.innerHTML = createProductHTML(p);
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
    loadCart();
    loadSalesHistory();
    // Note: products will update automatically via WebSocket
  } else {
    showNotification(data.message || "Checkout failed", "error");
  }
}

// ---------- Logout ----------
async function logout() {
  if (ws) ws.close();
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
  loadProducts(); // Initial load from API
  loadSalesHistory();
  connectWebSocket(); // Connect to WebSocket for real-time updates
};