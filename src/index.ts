import "dotenv/config";
import cors from "cors";
import express from "express";
import menuRouter from "./routes/menu";
import tablesRouter from "./routes/tables";

const app = express();
const PORT = 3001;

app.use(cors());
app.use(express.json());

app.get("/health", (_req, res) => {
  res.json({ status: "ok" });
});

app.use("/api/menu", menuRouter);
app.use("/api/tables", tablesRouter);

app.listen(PORT, () => {
  console.log(`Server running on http://localhost:${PORT}`);
});
