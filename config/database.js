const mysql = require('mysql2/promise');
require('dotenv').config();

// Create connection pool
const pool = mysql.createPool({
  host: process.env.DB_HOST || '127.0.0.1',
  port: parseInt(process.env.DB_PORT || '3306'),
  user: process.env.DB_USER || 'root',
  password: process.env.DB_PASS || '',
  database: process.env.DB_NAME || 'project_utility',
  waitForConnections: true,
  connectionLimit: 15,
  queueLimit: 0
});

/**
 * Initializes database schemas dynamically for all configured machines (e.g. oee_d1, oee_d10, etc.).
 * @param {Array} machines List of active machine configuration objects
 */
async function initializeAllTables(machines = []) {
  if (!machines.length) return;

  try {
    const connection = await pool.getConnection();
    console.log(`[DB] Connected to database '${process.env.DB_NAME || 'project_utility'}'. Initializing tables...`);

    for (const machine of machines) {
      const { tableName, oeeField, productField, id } = machine;

      const createTableQuery = `
        CREATE TABLE IF NOT EXISTS \`${tableName}\` (
          \`id\` INT AUTO_INCREMENT PRIMARY KEY,
          \`${oeeField}\` INT NOT NULL COMMENT 'Jumlah menit mesin hidup per jam',
          \`${productField}\` INT NOT NULL COMMENT 'Total counter produk terkemas',
          \`jam\` VARCHAR(10) NOT NULL COMMENT 'Format jam (misal 06.00)',
          \`machine_ts\` DATETIME NOT NULL COMMENT 'Timestamp jam pas (YYYY-MM-DD HH:00:00)',
          \`saved_at\` TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
          UNIQUE KEY \`idx_unique_hour\` (\`machine_ts\`)
        ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;
      `;

      await connection.query(createTableQuery);

      try {
        await connection.query(`ALTER TABLE \`${tableName}\` ADD UNIQUE INDEX \`idx_unique_hour\` (\`machine_ts\`)`);
      } catch (idxErr) {
        // Ignore if index already exists
      }

      console.log(`[DB] Table '${tableName}' verified/created for Machine ${id}.`);
    }

    connection.release();
  } catch (error) {
    console.error('[DB] Database initialization failed:', error.message);
    throw error;
  }
}

module.exports = {
  pool,
  initializeAllTables
};
