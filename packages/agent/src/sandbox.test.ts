import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { PublicKey } from "@solana/web3.js";

const FAKE_VALIDATOR = new PublicKey("9zoqdwEBKWEi9G5Ze8BSkdmppKMGm4FCAaWnwVpXgVx9");

vi.mock("@magicblock-labs/ephemeral-rollups-sdk", () => ({
  getClosestValidator: vi.fn(),
}));

vi.mock("@magicblock-labs/ephemeral-rollups-sdk/privacy", () => ({
  getAuthToken: vi.fn(),
}));

import { getClosestValidator } from "@magicblock-labs/ephemeral-rollups-sdk";
import { getAuthToken } from "@magicblock-labs/ephemeral-rollups-sdk/privacy";

import { provisionWithFallback, getSandboxProvider } from "./sandbox.js";
import type { Snapshot } from "./types.js";

const mockedGetClosestValidator = vi.mocked(getClosestValidator);
const mockedGetAuthToken = vi.mocked(getAuthToken);

const dummySnapshot: Snapshot = {
  programId: new PublicKey("CbdZT6zkBvgfaWCPUooeTkCZDuRz8Rfwmnhw2Nu6ZooC"),
  programData: Buffer.alloc(0),
  accounts: [],
  slot: 1n,
  capturedAtMs: 0,
};

describe("MagicBlockProvider.provision", () => {
  const ORIGINAL_ENV = { ...process.env };

  beforeEach(() => {
    vi.clearAllMocks();
    delete process.env.MAGICBLOCK_ROUTER_URL;
    delete process.env.MAGICBLOCK_AUTH_KEYPAIR;
  });

  afterEach(() => {
    process.env = { ...ORIGINAL_ENV };
  });

  it("throws when MAGICBLOCK_ROUTER_URL is unset (no silent fallback to junk)", async () => {
    const provider = getSandboxProvider("magicblock");
    await expect(provider.provision({ snapshot: dummySnapshot })).rejects.toThrow(
      /missing required env var: MAGICBLOCK_ROUTER_URL/,
    );
  });

  it("returns a magicblock-tagged sandbox with the router-selected validator", async () => {
    process.env.MAGICBLOCK_ROUTER_URL = "https://devnet.magicblock.app";
    mockedGetClosestValidator.mockResolvedValueOnce(FAKE_VALIDATOR);

    const sandbox = await getSandboxProvider("magicblock").provision({ snapshot: dummySnapshot });

    expect(sandbox.kind).toBe("magicblock");
    expect(sandbox.rpcUrl).toBe("https://devnet.magicblock.app");
    expect(sandbox.validator?.equals(FAKE_VALIDATOR)).toBe(true);
    expect(mockedGetClosestValidator).toHaveBeenCalledTimes(1);
    expect(mockedGetAuthToken).not.toHaveBeenCalled();
    await expect(sandbox.teardown()).resolves.toBeUndefined();
  });

  it("wraps unreachable router in a clear error (so fallback can decide what to do)", async () => {
    process.env.MAGICBLOCK_ROUTER_URL = "https://broken.example";
    mockedGetClosestValidator.mockRejectedValueOnce(new Error("ECONNREFUSED"));

    await expect(
      getSandboxProvider("magicblock").provision({ snapshot: dummySnapshot }),
    ).rejects.toThrow(/MagicBlock router unreachable.*ECONNREFUSED/);
  });

  it("provisionWithFallback drops to surfpool only after MagicBlock genuinely fails", async () => {
    process.env.MAGICBLOCK_ROUTER_URL = "https://broken.example";
    process.env.SURFPOOL_RPC_URL = "http://127.0.0.1:8899";
    mockedGetClosestValidator.mockRejectedValueOnce(new Error("ECONNREFUSED"));

    const sandbox = await provisionWithFallback("magicblock", { snapshot: dummySnapshot });

    expect(sandbox.kind).toBe("surfpool");
    expect(sandbox.validator).toBeUndefined();
    // Confirm we tried MagicBlock first — Surfpool fallback that skips
    // the primary provider would silently make non-private demos look
    // like Private-ER demos.
    expect(mockedGetClosestValidator).toHaveBeenCalledTimes(1);
  });

  it("provisionWithFallback honors an explicit surfpool preference without trying MagicBlock", async () => {
    process.env.SURFPOOL_RPC_URL = "http://127.0.0.1:8899";
    const sandbox = await provisionWithFallback("surfpool", { snapshot: dummySnapshot });
    expect(sandbox.kind).toBe("surfpool");
    expect(mockedGetClosestValidator).not.toHaveBeenCalled();
  });
});
