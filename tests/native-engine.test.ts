import {test, expect} from "bun:test";
import {createApp} from "../src/server";
import {Store} from "../src/store";

test("readiness restores the saved job without invoking Music or discovery", async () => {
  const store = new Store(":memory:");
  store.put("job", "saved", {id: "saved", state: "complete", tracks: [], updatedAt: "2026-01-01"});
  const unused = async (): Promise<never> => {throw new Error("Readiness must not invoke integrations");};
  const app = createApp({store, port: 8769, discovery: {getGenres: unused, buildDraft: unused}, music: {getMusicStatus: unused, ensurePlaylist: unused, addTrackToPlaylist: unused, openPlaylist: unused}});
  const response = await app.fetch(new Request("http://127.0.0.1:8769/api/ready", {headers: {host: "127.0.0.1:8769"}}));
  expect(response.status).toBe(200);
  const ready = await response.json();
  expect(ready.ready).toBe(true);
  expect(ready.activeJob.id).toBe("saved");
  store.close();
});
