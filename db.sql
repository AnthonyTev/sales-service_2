-- Sales Service Database Schema


CREATE DATABASE salesdb;

CREATE USER salesuser WITH PASSWORD 'yourpassword';
GRANT ALL PRIVILEGES ON DATABASE salesdb TO salesuser;

\c salesdb;

CREATE TABLE IF NOT EXISTS sales (
    id SERIAL PRIMARY KEY,
    username VARCHAR(100) NOT NULL,
    total_amount DECIMAL(10, 2) NOT NULL,
    sale_date TIMESTAMP DEFAULT CURRENT_TIMESTAMP
);

CREATE TABLE IF NOT EXISTS sale_items (
    id SERIAL PRIMARY KEY,
    sale_id INTEGER REFERENCES sales(id) ON DELETE CASCADE,
    product_id INTEGER NOT NULL,
    product_name VARCHAR(200) NOT NULL,
    price DECIMAL(10, 2) NOT NULL,
    quantity INTEGER NOT NULL,
    subtotal DECIMAL(10, 2) NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_sales_username ON sales(username);
CREATE INDEX IF NOT EXISTS idx_sales_date ON sales(sale_date);
CREATE INDEX IF NOT EXISTS idx_sale_items_sale_id ON sale_items(sale_id);

CREATE OR REPLACE VIEW sales_summary AS
SELECT 
    s.id as sale_id,
    s.username,
    s.total_amount,
    s.sale_date,
    si.product_id,
    si.product_name,
    si.price,
    si.quantity,
    si.subtotal
FROM sales s
LEFT JOIN sale_items si ON s.id = si.sale_id
ORDER BY s.sale_date DESC;