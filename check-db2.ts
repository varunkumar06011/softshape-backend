import { Database } from "bun:sqlite";
import { homedir } from "os";
const db = new Database(homedir() + "/.softshape/edge.db");
console.log("Print jobs:", db.query("SELECT id, event_id, status, printer_name, job_type, last_error FROM print_job ORDER BY created_at DESC LIMIT 10").all());
console.log("Orders:", db.query("SELECT id, table_id, status, total_amount, created_at FROM order_record ORDER BY created_at DESC LIMIT 5").all());
console.log("Edge config:", db.query("SELECT key, value FROM edge_config").all());
console.log("Sync state:", db.query("SELECT key, value FROM sync_state").all());
