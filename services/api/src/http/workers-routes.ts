import { Router } from "express";
import { listWorkers } from "../repositories/worker-repository";
import { scaleWorkers } from "../services/worker-service";
import { asyncHandler } from "./async-handler";
import { isInteger, MAX_WORKERS } from "./validation";

export const workersRouter = Router();

workersRouter.get(
  "/workers",
  asyncHandler(async (_req, res) => {
    res.json(await listWorkers());
  }),
);

workersRouter.put(
  "/workers",
  asyncHandler(async (req, res) => {
    const count = req.body?.count;
    if (!isInteger(count) || count < 0 || count > MAX_WORKERS) {
      return res.status(400).json({ error: `count must be an integer between 0 and ${MAX_WORKERS}` });
    }
    await scaleWorkers(count);
    res.json({ desired: count });
  }),
);
