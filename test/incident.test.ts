import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { createApp } from "../src/app.ts";
import { openDatabase } from "../src/db.ts";
import { approvedCivilDay } from "../src/deadlines.ts";
import { normalizeKey } from "../src/idempotency.ts";
import { seedIncident } from "../src/seed.ts";

type App = ReturnType<typeof createApp>;
type Ledger = { id: string; amount_brl: number };
type MissionView = {
  mission: { status: string };
  ledger: Ledger[];
  payout: { id: string; status: string } | null;
};

function setup(): App {
  const db = openDatabase(":memory:");
  seedIncident(db);
  return createApp(db);
}

function approve(app: App, mission_id: string, approved_at: string, idempotency_key: string) {
  return app.request("/approvals", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ mission_id, approved_at, idempotency_key }),
  });
}

function callback(app: App, payoutId: string, provider_status: string) {
  return app.request(`/payouts/${payoutId}/provider`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ provider_status }),
  });
}

async function mission(app: App, id: string): Promise<MissionView> {
  return (await (await app.request(`/missions/${id}`)).json()) as MissionView;
}

describe("replay de logs/incident.jsonl", () => {
  it("cada missão é creditada uma vez, em reais, e PENDING continua pendente", async () => {
    const app = setup();
    const lines = readFileSync(new URL("../logs/incident.jsonl", import.meta.url), "utf8")
      .trim()
      .split("\n")
      .map((line) => JSON.parse(line) as Record<string, string>);

    for (const line of lines) {
      if (line.msg === "approval.received") {
        const res = await approve(app, line.mission_id, line.approved_at, line.idempotency_key);
        expect(res.status, `${line.mission_id} ${JSON.stringify(line.idempotency_key)}`).toBeLessThan(300);
      }
      if (line.msg === "provider.callback") {
        const { payout } = await mission(app, line.mission_id);
        const res = await callback(app, payout?.id ?? "", line.provider_status);
        expect(((await res.json()) as { status: string }).status).toBe("pending");
      }
    }

    const expected: Array<[string, number]> = [
      ["msn_1842", 150],
      ["msn_1900", 150],
      ["msn_2044", 80],
    ];
    for (const [id, reais] of expected) {
      const view = await mission(app, id);
      expect(view.ledger, id).toHaveLength(1);
      expect(view.ledger[0]?.amount_brl, id).toBe(reais);
      expect(view.mission.status, id).toBe("approved");
    }
    expect((await mission(app, "msn_1900")).payout?.status).toBe("pending");
  });
});

describe("prazo no dia civil de São Paulo", () => {
  it.each([
    ["2026-03-13T02:59:59.999Z", 201, "23:59:59.999 em SP, já dia 13 em UTC"],
    ["2026-03-12T23:59:59.999-03:00", 201, "o mesmo instante com offset"],
    ["2026-03-12T00:30:00.000Z", 201, "21:30 do dia 11 em SP, já dia 12 em UTC"],
    ["2026-03-13T03:00:00.000Z", 409, "00:00 do dia seguinte em SP"],
    ["2026-03-13T00:00:00.000-03:00", 409, "o mesmo instante com offset"],
  ])("%s responde %i (%s)", async (approvedAt, status) => {
    expect((await approve(setup(), "msn_1842", approvedAt, "pay_edge")).status).toBe(status);
  });

  it("dá o dia em São Paulo, não em UTC", () => {
    expect(approvedCivilDay("2026-03-13T01:02:00.000Z")).toBe("2026-03-12");
    expect(approvedCivilDay("2026-03-13T03:00:00.000Z")).toBe("2026-03-13");
  });
});

describe("idempotência", () => {
  it("ignora espaço nas pontas e caracteres invisíveis da chave", () => {
    for (const key of ["pay_7c1 ", " pay_7c1", "pay_7c1​", "﻿pay_7c1", "pay_‍7c1", "PAY_7C1"]) {
      expect(normalizeKey(key), JSON.stringify(key)).toBe("pay_7c1");
    }
  });

  it("não credita de novo quando a chave volta com um caractere invisível", async () => {
    const app = setup();
    expect((await approve(app, "msn_2044", "2026-03-12T21:05:00.000Z", "pay_7c1")).status).toBe(201);
    expect((await approve(app, "msn_2044", "2026-03-12T21:05:00.000Z", "pay_7c1​")).status).toBe(200);
    const view = await mission(app, "msn_2044");
    expect(view.ledger).toHaveLength(1);
    expect(view.ledger[0]?.amount_brl).toBe(80);
  });

  it("credita a missão uma vez mesmo com outra chave", async () => {
    const app = setup();
    const first = (await (await approve(app, "msn_1900", "2026-03-12T18:11:00.000Z", "pay_a")).json()) as {
      ledger: Ledger;
    };
    const again = await approve(app, "msn_1900", "2026-03-12T18:11:00.000Z", "pay_b");
    expect(again.status).toBe(200);
    expect(((await again.json()) as { ledger: Ledger }).ledger.id).toBe(first.ledger.id);
    expect((await mission(app, "msn_1900")).ledger).toHaveLength(1);
  });

  it("recusa com 409 a chave já usada em outra missão e não credita nada", async () => {
    const app = setup();
    expect((await approve(app, "msn_1900", "2026-03-12T18:11:00.000Z", "pay_shared")).status).toBe(201);
    expect((await approve(app, "msn_2044", "2026-03-20T15:00:00.000Z", " pay_shared")).status).toBe(409);
    const view = await mission(app, "msn_2044");
    expect(view.ledger).toHaveLength(0);
    expect(view.mission.status).toBe("open");
  });

  it("recusa com 400 uma chave feita só de caracteres invisíveis", async () => {
    expect((await approve(setup(), "msn_2044", "2026-03-20T15:00:00.000Z", " ​ ")).status).toBe(400);
  });
});

describe("status do provedor", () => {
  it("só quita com RECEIVED ou CONFIRMED", async () => {
    const app = setup();
    const { payout } = (await (await approve(app, "msn_2044", "2026-03-20T15:00:00.000Z", "pay_p")).json()) as {
      payout: { id: string };
    };
    const statusOf = async (providerStatus: string) =>
      ((await (await callback(app, payout.id, providerStatus)).json()) as { status: string }).status;
    expect(await statusOf("PENDING")).toBe("pending");
    expect(await statusOf("CONFIRMED")).toBe("paid");
    expect(await statusOf("RECEIVED")).toBe("paid");
    expect(await statusOf("FAILED")).toBe("failed");
  });
});
