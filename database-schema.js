import pkg from 'pg';
const { Pool } = pkg;

const pool = new Pool({
  user: "postgres",      // change this
  host: "localhost",
  database: "salesdb",   // change this
  password: "password",  // change this
  port: 5432
});

export default pool;
