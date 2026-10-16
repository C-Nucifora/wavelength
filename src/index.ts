import {createApp} from "./server";
import {Store} from "./store";
import * as discovery from "./discovery";
import * as historyMusic from "./music";
import {createWebMusicAdapter, stopOwnedHelpers} from "./web-music";

const port = Number(process.env.PORT || 8769);
if (!Number.isInteger(port) || (port !== 0 && port < 1024) || port > 65535) throw new Error("PORT must be 0 or between 1024 and 65535.");
const store = new Store();
let app: ReturnType<typeof createApp>;
const server = Bun.serve({hostname: "127.0.0.1", port, fetch: request => app.fetch(request), idleTimeout: 120, maxRequestBodySize: 20 * 1024 * 1024});
app = createApp({store, port: server.port!, discovery, music: createWebMusicAdapter(), readLibraryHistory: historyMusic.readLibraryHistory});
console.log(`Wavelength is ready at http://127.0.0.1:${server.port}`);
if (process.argv.includes("--open")) Bun.spawn(["/usr/bin/open", "-a", "Safari", `http://127.0.0.1:${server.port}`]);
function stop() {app.dispose(); stopOwnedHelpers(); historyMusic.stopOwnedHelpers(); server.stop(true); store.close(); process.exit(0);}
process.on("SIGINT", stop);
process.on("SIGTERM", stop);
