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

test("native engine token protects bootstrap and every read before integrations", async () => {
  const store = new Store(":memory:");
  const unused = async (): Promise<never> => {throw new Error("Must not invoke integrations");};
  const app = createApp({engineToken: "parent-only-token", store, port: 8769, discovery: {getGenres: unused, buildDraft: unused}, music: {getMusicStatus: unused, ensurePlaylist: unused, addTrackToPlaylist: unused, openPlaylist: unused}});
  try {
    for (const path of ["/", "/api/session", "/api/ready", "/api/status", "/api/history", "/api/jobs/saved"]) {
      for (const token of ["", "wrong"]) expect((await app.fetch(new Request(`http://127.0.0.1:8769${path}`, {headers: {host: "127.0.0.1:8769", "x-wavelength-token": token}}))).status).toBe(403);
    }
    const headers = {host: "127.0.0.1:8769", "x-wavelength-token": "parent-only-token"};
    expect((await app.fetch(new Request("http://127.0.0.1:8769/api/ready", {headers}))).status).toBe(200);
    expect(await (await app.fetch(new Request("http://127.0.0.1:8769/api/session", {headers}))).json()).toEqual({token: "parent-only-token"});
  } finally {app.dispose(); store.close();}
});
