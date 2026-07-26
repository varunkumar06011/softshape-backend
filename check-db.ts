import { Database } from "bun:sqlite";
import { homedir } from "os";
const db = new Database(homedir() + "/.softshape/edge.db");
console.log("Tables:", db.query("SELECT name FROM sqlite_master WHERE type='table' ORDER BY name").all());
console.log("Venues:", db.query("SELECT id, name, kot_enabled FROM venue").all());
console.log("Outlet printer config:", db.query("SELECT id, printer_config FROM outlet").all());
