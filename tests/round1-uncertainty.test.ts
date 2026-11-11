import {expect, test} from "bun:test";
import {createWebMusicAdapter, runBridgeRequest} from "../src/web-music";
import {Jobs} from "../src/jobs";
import {Store} from "../src/store";
import type {DraftTrack} from "../src/types";

test.each(["unexpected-bridge-code", "constructor"])("unknown helper error %s cannot clear possible-write intent", async code => {
  const command = [process.execPath, "-e", `await Bun.stdin.text(); console.log(JSON.stringify({ok:false,error:{code:${JSON.stringify(code)},uncertain:false}}));`];
  await expect(runBridgeRequest({action: "ensurePlaylist", generation: "synthetic", name: "Synthetic", catalogIds: ["1"]}, {command, timeoutMs: 2000})).rejects.toMatchObject({code: "malformed", uncertain: true});
});

test.each(["unexpected-bridge-code", "constructor"])("Jobs retains creation uncertainty after helper error %s and blocks a second create", async code => {
  const store = new Store(":memory:");
  let creates = 0;
  const command = [process.execPath, "-e", `await Bun.stdin.text(); console.log(JSON.stringify({ok:false,error:{code:${JSON.stringify(code)},uncertain:false}}));`];
  const jobs = new Jobs(store, createWebMusicAdapter(async input => {
    if (input.action === "status") return {generation: "synthetic"};
    if (input.action !== "ensurePlaylist") throw new Error("Unexpected synthetic action");
    creates++;
    return runBridgeRequest(input, {command, timeoutMs: 2000});
  }));
  const track: DraftTrack = {id: "1", catalogId: 1, artistId: 1, title: "Synthetic", artist: "Fixture", album: "Fixture", durationMs: 1000, releaseDate: "2026-01-01", url: "https://example.invalid", source: "fixture", match: "exact", selected: true, provenance: {kind: "unknown", evidence: []}};
  try {
    const job = jobs.create("Synthetic", [track], false, "synthetic");
    for (let i = 0; i < 400 && jobs.isActive(); i++) await Bun.sleep(10);
    expect(jobs.isActive()).toBe(false);
    // Exercise retry even on the broken implementation so the duplicate is observed.
    let retryError: unknown;
    try {jobs.retry(job.id);} catch (error) {retryError = error;}
    for (let i = 0; i < 400 && jobs.isActive(); i++) await Bun.sleep(10);
    expect(jobs.isActive()).toBe(false);
    expect(creates).toBe(1);
    expect(retryError).toBeInstanceOf(Error);
    expect(jobs.get(job.id)).toMatchObject({creationState: "unknown", tracks: [{state: "adding", outcome: "uncertain"}]});
  } finally {store.close();}
});

test("native error codes retain their explicit uncertainty without exposing helper text", async () => {
  const codes = ["unavailable", "invalid-input", "generation-changed", "storefront-mismatch", "catalog-date", "busy", "missing", "storage", "rejected", "malformed", "transport"];
  for (const code of codes) for (const uncertain of [false, true]) {
    const command = [process.execPath, "-e", `await Bun.stdin.text(); console.log(JSON.stringify({ok:false,error:{code:${JSON.stringify(code)},uncertain:${uncertain},message:"private synthetic diagnostic"}}));`];
    let caught: unknown;
    try {await runBridgeRequest({action: "ensurePlaylist"}, {command, timeoutMs: 2000});} catch (error) {caught = error;}
    expect(caught).toMatchObject({code, uncertain});
    expect((caught as Error).message).not.toContain("private synthetic diagnostic");
    expect((caught as Error).message).not.toContain("function");
  }
});
