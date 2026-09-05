/**
 * PulseBill Telecom Technologies Inc.
 * Standalone Demonstration Seed Script
 * Generates anonymized enterprise subscribers, internet plans, and monthly invoices.
 */

const pool = require('../config/database');

async function seed() {
  console.log('[PulseBill] Initializing database schema and mock fixtures...');

  // Create mock tables if they do not exist
  await pool.query(`
    CREATE TABLE IF NOT EXISTS packages (
      id INT AUTO_INCREMENT PRIMARY KEY,
      name VARCHAR(100) NOT NULL,
      speed VARCHAR(50) NOT NULL,
      price DECIMAL(10,2) NOT NULL,
      profile_name VARCHAR(100) NOT NULL,
      description TEXT
    )
  `);

  await pool.query(`
    CREATE TABLE IF NOT EXISTS customers (
      id INT AUTO_INCREMENT PRIMARY KEY,
      account_number VARCHAR(50) UNIQUE NOT NULL,
      name VARCHAR(100) NOT NULL,
      phone VARCHAR(50),
      email VARCHAR(100),
      address TEXT,
      package_id INT,
      status VARCHAR(20) DEFAULT 'active',
      pppoe_username VARCHAR(100),
      pppoe_password VARCHAR(100),
      created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
    )
  `);

  await pool.query(`
    CREATE TABLE IF NOT EXISTS invoices (
      id INT AUTO_INCREMENT PRIMARY KEY,
      invoice_number VARCHAR(50) UNIQUE NOT NULL,
      customer_id INT NOT NULL,
      amount DECIMAL(10,2) NOT NULL,
      status VARCHAR(20) DEFAULT 'unpaid',
      due_date DATE,
      paid_at TIMESTAMP NULL,
      payment_method VARCHAR(50),
      created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
    )
  `);

  console.log('[PulseBill] Tables verified. Seeding demo records...');

  // Insert demo packages
  const packages = [
    { name: 'Fiber Starter', speed: '50 Mbps Symmetrical', price: 39.99, profile_name: '50M_Symmetrical', description: 'Entry-level FTTH residential tier' },
    { name: 'Fiber Pro Business', speed: '250 Mbps Symmetrical', price: 89.99, profile_name: '250M_Symmetrical', description: 'SMB high-speed low-latency connection' },
    { name: 'Gigabit Enterprise', speed: '1 Gbps Symmetrical', price: 199.99, profile_name: '1G_Enterprise', description: 'Dedicated enterprise throughput with SLA' }
  ];

  for (const pkg of packages) {
    await pool.query(
      'INSERT INTO packages (name, speed, price, profile_name, description) VALUES (?, ?, ?, ?, ?)',
      [pkg.name, pkg.speed, pkg.price, pkg.profile_name, pkg.description]
    );
  }

  // Insert demo customers
  const customers = [
    { account_number: 'PB-CUST-1001', name: 'Marcus Vance', phone: '+15550192801', email: 'marcus.vance@example.com', address: '402 Market St, Suite 100', package_id: 1, pppoe_username: 'marcus_vance', pppoe_password: 'secret_password_1' },
    { account_number: 'PB-CUST-1002', name: 'Elena Rostova', phone: '+15550192802', email: 'elena.rostova@example.com', address: '120 Innovation Way', package_id: 3, pppoe_username: 'elena_rostova', pppoe_password: 'secret_password_2' },
    { account_number: 'PB-CUST-1003', name: 'Devon Chen', phone: '+15550192803', email: 'devon.chen@example.com', address: '78 Pine Ridge Ave', package_id: 2, pppoe_username: 'devon_chen', pppoe_password: 'secret_password_3' }
  ];

  for (const cust of customers) {
    await pool.query(
      'INSERT INTO customers (account_number, name, phone, email, address, package_id, pppoe_username, pppoe_password) VALUES (?, ?, ?, ?, ?, ?, ?, ?)',
      [cust.account_number, cust.name, cust.phone, cust.email, cust.address, cust.package_id, cust.pppoe_username, cust.pppoe_password]
    );
  }

  // Insert demo invoices
  const invoices = [
    { invoice_number: 'INV-2026-0001', customer_id: 1, amount: 39.99, status: 'paid', due_date: '2026-09-30', paid_at: new Date(), payment_method: 'Stripe' },
    { invoice_number: 'INV-2026-0002', customer_id: 2, amount: 199.99, status: 'paid', due_date: '2026-09-30', paid_at: new Date(), payment_method: 'Credit Card' },
    { invoice_number: 'INV-2026-0003', customer_id: 3, amount: 89.99, status: 'unpaid', due_date: '2026-09-30', paid_at: null, payment_method: null }
  ];

  for (const inv of invoices) {
    await pool.query(
      'INSERT INTO invoices (invoice_number, customer_id, amount, status, due_date, paid_at, payment_method) VALUES (?, ?, ?, ?, ?, ?, ?)',
      [inv.invoice_number, inv.customer_id, inv.amount, inv.status, inv.due_date, inv.paid_at, inv.payment_method]
    );
  }

  console.log('[PulseBill] Seeding completed successfully!');
  process.exit(0);
}

seed().catch(err => {
  console.error('[PulseBill] Seeding encountered error:', err.message);
  process.exit(1);
});
