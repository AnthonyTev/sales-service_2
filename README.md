# Sales Service 🛒

A simple Sales Service system for school supplies, built with **Node.js**, **Express**, and **PostgreSQL**.  
This project is part of an integration task where it will later connect with an **Inventory Service** (C# + SQLite).

---

## Features
- **Login Page** (username: `user`, password: `pass123`)
- **Main Page**
  - Product list (Pen, Notebook, Paper)
  - Add to cart
  - Checkout with total price
- **Log Out**

---

## Tech Stack
- **Backend**: Node.js + Express
- **Database**: PostgreSQL
- **Frontend**: EJS templates + Bootstrap

---

## Setup Instructions

### 1. Clone the repository

```bash
git clone https://github.com/AnthonyTev/sales-service_2.git
cd sales-service_2
```

### 2. Install dependencies

```bash
npm install
npm install ws
```

### 3. Configure PostgreSQL

- Create a database

paste db.sql's contents into psql
```

- Update your `.env` file with DB credentials:

```env
DB_USER=salesuser
DB_PASSWORD=yourpassword
DB_HOST=localhost
DB_PORT=5432
DB_NAME=salesdb
```

### 4. Run the app

```bash
npm start
```

Open your browser at http://localhost:3000/login.html

---

## Future Integration
- This service will integrate with the **Inventory Service**
- Planned integration: syncing product stock levels and sales updates
