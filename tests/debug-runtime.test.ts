import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import type { Actor } from "../packages/api/src/contract";
import { emptyRules } from "../packages/gateway/src/index";
import { createAccountTestDatabase } from "./account-database";
import { startFixture } from "./fixture";

describe.skipIf(!process.env.TEST_BASE_URL)("self-hosted live capture wiring", () => {
    let storage: Awaited<ReturnType<typeof createAccountTestDatabase>>, fixture: Awaited<ReturnType<typeof startFixture>>;
    let runtime: typeof import("../apps/web/src/server/runtime");
    const actor: Actor = { userId: randomUUID(), scopeId: "" };
    actor.scopeId = actor.userId;
    let connectionId: string, agentId: string;
    beforeAll(async () => {
        storage = await createAccountTestDatabase();
        vi.stubEnv("DATABASE_URL", storage.url);
        vi.stubEnv("TOOLSTILE_TELEMETRY_URL", "");
        runtime = await import("../apps/web/src/server/runtime");
        fixture = await startFixture();
        await runtime.pool.query("insert into \"user\"(id,name,email) values($1,'Debug user',$2)", [actor.userId, `${actor.userId}@test.invalid`]);
        connectionId = (await runtime.services.addConnection(actor, {
            label: "Capture fixture",
            url: fixture.url,
            transport: "http",
            authentication: "headers",
            headers: { Authorization: "Bearer local-header-secret" },
        })).id;
        const device = await runtime.services.addDevice(actor, "Capture device");
        agentId = (await runtime.services.addAgent(actor, {
            deviceId: device.id,
            label: "Capture agent",
            expiresInDays: null,
        })).id;
        const rules = emptyRules();
        rules.full = true;
        await runtime.services.saveGrant(actor, { agentId, connectionId, rules });
    });
    afterAll(async () => {
        await fixture.close();
        await runtime.pool.end();
        await storage.close();
        vi.unstubAllEnvs();
    });
    const api = () => ({
        testTool: (input: Parameters<typeof runtime.services.testTool>[1]) => runtime.services.testTool(actor, input),
        debugStatus: () => runtime.services.debugStatus(actor),
        startDebug: (input: Parameters<typeof runtime.services.startDebug>[1]) => runtime.services.startDebug(actor, input),
        stopDebug: (input: {
            id: string;
        }) => runtime.services.stopDebug(actor, input.id),
        debugPayload: (input: {
            id: string;
        }) => runtime.services.debugPayload(actor, input.id),
    });
    const call = () => api().testTool({
        agentId,
        connectionId,
        name: "read_docs",
        arguments: {
            text: "local-debug-content",
            access_token: "local-oauth-secret",
        },
    });
    it("records metadata only until opt-in, then captures SDK results with matching activity identity", async () => {
        await call();
        expect((await api().debugStatus()).payloads).toEqual([]);
        await api().startDebug({
            agentIds: [agentId],
            connectionIds: [connectionId],
        });
        await call();
        const status = await api().debugStatus();
        expect(status.payloads).toHaveLength(1);
        const payload = await api().debugPayload({ id: status.payloads[0].id });
        expect(payload.arguments).toEqual({
            text: "local-debug-content",
            access_token: "[redacted]",
        });
        expect(JSON.stringify(payload.result)).toContain("local fixture success");
        const { rows: [row], } = await runtime.pool.query('select a.method,p."encryptedPayload" from activity a join debug_payloads p on p.id=a.id where a.id=$1', [status.payloads[0].id]);
        expect(row.method).toBe("tools/call");
        expect(row.encryptedPayload).not.toContain("local-debug-content");
        expect(JSON.stringify(payload)).not.toContain("local-header-secret");
    });
    it("explicit stop and live revocation prevent further payload storage", async () => {
        const status = await api().debugStatus();
        await api().stopDebug({ id: status.sessions[0].id });
        await call();
        expect((await api().debugStatus()).payloads).toHaveLength(1);
        await api().startDebug({
            agentIds: [agentId],
            connectionIds: [connectionId],
        });
        await runtime.services.revokeAgent(actor, agentId);
        await expect(call()).rejects.toThrow();
        expect((await api().debugStatus()).payloads).toHaveLength(1);
    });
});
