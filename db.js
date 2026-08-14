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
  connectionLimit: 10,
  queueLimit: 0
});

/**
 * Initializes database by creating the required oee_d1 table if it doesn't exist.
 */
async function initializeDatabase() {
  try {
    const connection = await pool.getConnection();
    console.log(`[DB] Connected to database: ${process.env.DB_NAME}`);
    
    // SQL to create the table
    const createTableQuery = `
      CREATE TABLE IF NOT EXISTS \`oee_d1\` (
        \`id\` INT AUTO_INCREMENT PRIMARY KEY,
        \`oee_d1\` INT NOT NULL COMMENT 'Jumlah mesin hidup dalam menit',
        \`ct_productd1\` INT NOT NULL,
        \`jam\` VARCHAR(10) NOT NULL COMMENT 'Format jam (misal 06.00)',
        \`machine_ts\` DATETIME NOT NULL COMMENT 'Timestamp jam pas dari mesin (YYYY-MM-DD HH:00:00)',
        \`saved_at\` TIMESTAMP DEFAULT CURRENT_TIMESTAMP COMMENT 'Waktu penyimpanan data ke DB',
        UNIQUE KEY \`idx_unique_hour\` (\`machine_ts\`)
      ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;
    `;
    
    await connection.query(createTableQuery);

    // Try adding unique index for existing tables (ignore if already exists)
    try {
      await connection.query(`ALTER TABLE \`oee_d1\` ADD UNIQUE INDEX \`idx_unique_hour\` (\`machine_ts\`)`);
    } catch (idxErr) {
      // Ignore index already exists error
    }

    console.log(`[DB] Table 'oee_d1' verified/created successfully.`);
    connection.release();
  } catch (error) {
    console.error('[DB] Failed to initialize database:', error.message);
    throw error;
  }
}

module.exports = {
  pool,
  initializeDatabase
};
