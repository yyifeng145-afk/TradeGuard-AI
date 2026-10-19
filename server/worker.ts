import { initDatabase } from "./db.js";
import { startWorker } from "./engine.js";
import { startInternalNotificationWorker } from "./feishu.js";

initDatabase();
startWorker();
startInternalNotificationWorker();
console.log("CRM Worker started");
