import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("server-only", () => ({}));

describe("client onboarding invitation material", () => {
  beforeEach(() => {
    vi.resetModules();
    process.env.NEXT_PUBLIC_SITE_URL = "https://dropscale.app";
  });

  it("uses a 256-bit fragment bearer and stores only its stable digest", async () => {
    const {
      createClientOnboardingInvitationMaterial,
      hashClientOnboardingToken,
      isClientOnboardingId,
      isClientOnboardingToken,
    } = await import("./invitations");
    const material = await createClientOnboardingInvitationMaterial(
      new Date("2026-08-12T12:00:00.000Z"),
    );

    expect(isClientOnboardingId(material.id)).toBe(true);
    expect(isClientOnboardingToken(material.token)).toBe(true);
    expect(material.token).toHaveLength(43);
    expect(material.tokenHash).toMatch(/^[0-9a-f]{64}$/);
    expect(await hashClientOnboardingToken(material.token)).toBe(material.tokenHash);
    expect(material.url).toBe(
      `https://dropscale.app/onboarding/client/${material.id}#${material.token}`,
    );
    expect(material.expiresAt).toBe("2026-08-19T12:00:00.000Z");
  });

  it("rejects unsafe public origins", async () => {
    process.env.NEXT_PUBLIC_SITE_URL = "http://dropscale.app";
    const { createClientOnboardingInvitationMaterial } = await import("./invitations");
    await expect(createClientOnboardingInvitationMaterial()).rejects.toThrow(/safe HTTPS/i);
  });
});
