/**
 * Seeds a fresh central database.
 *   npm run seed                      → company + admin user only
 *   npm run seed -- --demo            → plus demo warehouses, branches, users, products, supplier
 * Env: SEED_ADMIN_USERNAME (default "admin"), SEED_ADMIN_PASSWORD (required outside --demo)
 */
import 'dotenv/config';
import { uuidv7 } from '@store/shared';
import { createPool, one, withTransaction } from './pool.js';
import { migrate } from './migrate.js';
import { hashPassword } from '../auth/password.js';

const demo = process.argv.includes('--demo');
const db = createPool(process.env.DATABASE_URL ?? 'postgres://store:store@localhost:5432/store', 2);

async function main() {
  await migrate(db, console.log);
  const existing = await one(db, 'SELECT id FROM company');
  if (existing) {
    console.log('Database already seeded; nothing to do.');
    return;
  }
  const adminUser = process.env.SEED_ADMIN_USERNAME ?? 'admin';
  const adminPass = process.env.SEED_ADMIN_PASSWORD ?? (demo ? 'Admin@1234' : '');
  if (adminPass.length < 8) throw new Error('Set SEED_ADMIN_PASSWORD (min 8 chars, letters and digits)');

  await withTransaction(db, async (tx) => {
    await tx.query(
      `INSERT INTO company (id, name, gstin, state_code, address, branch_to_branch_enabled) VALUES ($1,$2,$3,$4,$5,$6)`,
      [uuidv7(), process.env.SEED_COMPANY_NAME ?? 'StoreCo Retail Pvt Ltd', demo ? '36AABCS1234Z1Z5' : null, process.env.SEED_STATE_CODE ?? '36', 'Hyderabad', false],
    );
    await tx.query(
      `INSERT INTO users (id, username, full_name, password_hash, role, all_locations) VALUES ($1,$2,'Company Administrator',$3,'COMPANY_ADMIN',true)`,
      [uuidv7(), adminUser, await hashPassword(adminPass)],
    );
    if (!demo) return;

    const loc = async (code: string, name: string, type: string, prefix: string) => {
      const id = uuidv7();
      await tx.query(
        `INSERT INTO locations (id, code, name, type, address, state_code, invoice_prefix, can_receive_purchases) VALUES ($1,$2,$3,$4,$5,'36',$6,$7)`,
        [id, code, name, type, `${name}, Hyderabad`, prefix, type === 'WAREHOUSE'],
      );
      return id;
    };
    const wA = await loc('WHA', 'Gudovun A', 'WAREHOUSE', 'WA');
    const wB = await loc('WHB', 'Gudovun B', 'WAREHOUSE', 'WB');
    const b1 = await loc('BR1', 'Branch 1 - Ameerpet', 'BRANCH', 'B1');
    const b2 = await loc('BR2', 'Branch 2 - Kukatpally', 'BRANCH', 'B2');

    const user = async (username: string, name: string, role: string, locs: string[]) => {
      const id = uuidv7();
      await tx.query(`INSERT INTO users (id, username, full_name, password_hash, role) VALUES ($1,$2,$3,$4,$5)`, [
        id, username, name, await hashPassword('Demo@1234'), role,
      ]);
      for (const l of locs) await tx.query('INSERT INTO user_locations VALUES ($1,$2)', [id, l]);
    };
    await user('whmanager', 'Ravi (Warehouse Manager)', 'WAREHOUSE_MANAGER', [wA, wB]);
    await user('br1manager', 'Lakshmi (Branch 1 Manager)', 'BRANCH_MANAGER', [b1]);
    await user('br1cashier', 'Suresh (Branch 1 POS)', 'SALES_STAFF', [b1]);
    await user('br2cashier', 'Anitha (Branch 2 POS)', 'SALES_STAFF', [b2]);
    await user('purchase', 'Kiran (Purchase)', 'PURCHASE_STAFF', [wA, wB]);
    await user('accounts', 'Meena (Accounts)', 'ACCOUNTS_STAFF', [wA, wB, b1, b2]);

    const cat = async (name: string) => {
      const id = uuidv7();
      await tx.query('INSERT INTO categories (id, name) VALUES ($1,$2)', [id, name]);
      return id;
    };
    const grocery = await cat('Grocery');
    const personal = await cat('Personal Care');
    const home = await cat('Home Essentials');
    const products: [string, string, string, string, number, number, number, number, string][] = [
      ['RICE-BAS-5', 'Basmati Rice 5kg', grocery, '1006', 500, 42000, 52000, 55000, '8901000000011'],
      ['ATTA-10', 'Whole Wheat Atta 10kg', grocery, '1101', 500, 36000, 44000, 46000, '8901000000028'],
      ['DAL-TOOR-1', 'Toor Dal 1kg', grocery, '0713', 500, 11000, 14500, 15500, '8901000000035'],
      ['OIL-SUN-1', 'Sunflower Oil 1L', grocery, '1512', 500, 12500, 15500, 16500, '8901000000042'],
      ['SOAP-NEEM', 'Neem Soap 100g', personal, '3401', 1800, 2400, 3500, 3800, '8901000000059'],
      ['SHAMPOO-200', 'Herbal Shampoo 200ml', personal, '3305', 1800, 9500, 14000, 15000, '8901000000066'],
      ['TPASTE-150', 'Toothpaste 150g', personal, '3306', 1800, 6500, 9500, 10000, '8901000000073'],
      ['DETER-1KG', 'Detergent Powder 1kg', home, '3402', 1800, 9000, 12500, 13000, '8901000000080'],
      ['DISHWASH-500', 'Dishwash Gel 500ml', home, '3402', 1800, 8000, 11000, 12000, '8901000000097'],
      ['BULB-LED-9W', 'LED Bulb 9W', home, '8539', 1200, 6000, 9900, 12000, '8901000000103'],
    ];
    for (const [sku, name, catId, hsn, rate, cost, price, mrp, barcode] of products) {
      const id = uuidv7();
      await tx.query(
        `INSERT INTO products (id, sku, name, category_id, hsn_code, unit, gst_rate_bp, purchase_price, selling_price, mrp, reorder_level)
         VALUES ($1,$2,$3,$4,$5,'pcs',$6,$7,$8,$9,10)`,
        [id, sku, name, catId, hsn, rate, cost, price, mrp],
      );
      await tx.query(`INSERT INTO product_barcodes (barcode, product_id) VALUES ($1,$2)`, [barcode, id]);
    }
    await tx.query(
      `INSERT INTO suppliers (id, name, gstin, state_code, phone, email) VALUES ($1,'Deccan Wholesale Traders','36AAACD1234E1Z2','36','9000000001','orders@deccan.example')`,
      [uuidv7()],
    );
  });
  console.log(`Seeded company and admin user "${adminUser}"${demo ? ' with demo data (demo users password: Demo@1234)' : ''}.`);
}

main()
  .catch((err) => {
    console.error(err.message);
    process.exitCode = 1;
  })
  .finally(() => db.end());
