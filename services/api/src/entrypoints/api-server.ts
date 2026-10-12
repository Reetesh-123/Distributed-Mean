/** Process 1: the HTTP API and the dashboard. It never touches the numbers, only job metadata. */
import express from "express";
import path from "path";
import { config } from "../config";
import { jobsRouter } from "../http/jobs-routes";
import { statsRouter } from "../http/stats-routes";
import { workersRouter } from "../http/workers-routes";

const app = express();
app.use(express.json());
app.use(statsRouter);
app.use(jobsRouter);
app.use(workersRouter);
app.use(express.static(path.join(__dirname, "..", "..", "public"))); // dashboard

// Last middleware: log the real error, return a generic message.
app.use((err: Error, _req: express.Request, res: express.Response, _next: express.NextFunction) => {
  console.error(err);
  res.status(500).json({ error: "internal error" });
});

app.listen(config.httpPort, () => console.log(`api listening on ${config.httpPort}`));
