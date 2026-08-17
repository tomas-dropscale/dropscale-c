import type { ReactNode } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  listSessions: vi.fn(),
  listRoster: vi.fn(),
  listCommissions: vi.fn(),
  getSessionProfile: vi.fn(),
  manager: vi.fn(),
}));

vi.mock("@/lib/client-onboarding/sessions", () => ({
  listClientOnboardingSessions: mocks.listSessions,
}));
vi.mock("@/lib/client-onboarding/legacy-roster", () => ({
  listExistingClientRoster: mocks.listRoster,
}));
vi.mock("@/lib/admin/client-commissions", () => ({
  listAdminCommissionClients: mocks.listCommissions,
}));
vi.mock("@/lib/supabase/server", () => ({
  getSessionProfile: mocks.getSessionProfile,
}));
vi.mock("@/components/admin/client-onboarding-manager", () => ({
  ClientOnboardingManager: (props: {
    initialSessions: Array<{ id: string }>;
    initialRoster: Array<{ clientId: string; fullName: string }>;
    initialCommissionClients: Array<{ id: string; name: string }>;
    backendLoadFailed: boolean;
    rosterLoadFailed: boolean;
    commissionLoadFailed: boolean;
    adminId: string;
  }) => {
    mocks.manager(props);
    return (
      <section>
        <h2>Client onboarding</h2>
        {props.initialRoster.map((client) => (
          <p key={client.clientId}>{client.fullName}</p>
        ))}
      </section>
    );
  },
}));
vi.mock("@/components/ui/button", () => ({
  Button: ({ children }: { children: ReactNode }) => <>{children}</>,
}));
vi.mock("@/components/ui/page-container", () => ({
  PageContainer: ({
    title,
    description,
    actions,
    children,
  }: {
    title: ReactNode;
    description: ReactNode;
    actions: ReactNode;
    children: ReactNode;
  }) => (
    <main>
      <h1>{title}</h1>
      <p>{description}</p>
      <nav>{actions}</nav>
      {children}
    </main>
  ),
}));

import AdminClientsPage from "./page";

describe("Clients page", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.listSessions.mockResolvedValue([{ id: "session-1" }]);
    mocks.listRoster.mockResolvedValue([
      { clientId: "client-1", fullName: "Northwind Commerce" },
    ]);
    mocks.listCommissions.mockResolvedValue([
      { id: "client-1", name: "Northwind Commerce" },
    ]);
    mocks.getSessionProfile.mockResolvedValue({ profile: { id: "admin-1" } });
  });

  it("restores the approved roster and onboarding manager as the primary Clients surface", async () => {
    const html = renderToStaticMarkup(await AdminClientsPage());

    expect(html).toContain("Clients");
    expect(html).toContain("Client onboarding");
    expect(html).toContain("Northwind Commerce");
    expect(html).not.toContain("Commission by client");
    // The onboarding twin page now redirects here; the page must not link
    // back into it and recreate the impression of a second clients list.
    expect(html).not.toContain('href="/admin/client-onboarding"');
    expect(html).toContain('href="/admin/referrals"');
    expect(mocks.manager).toHaveBeenCalledWith(
      expect.objectContaining({
        initialSessions: [{ id: "session-1" }],
        initialRoster: [{ clientId: "client-1", fullName: "Northwind Commerce" }],
        initialCommissionClients: [{ id: "client-1", name: "Northwind Commerce" }],
        backendLoadFailed: false,
        rosterLoadFailed: false,
        commissionLoadFailed: false,
        adminId: "admin-1",
      }),
    );
  });

  it("keeps client management available when only commercial terms fail", async () => {
    mocks.listCommissions.mockRejectedValueOnce(new Error("commission catalogue unavailable"));

    const html = renderToStaticMarkup(await AdminClientsPage());

    expect(html).toContain("Client onboarding");
    expect(html).toContain("Northwind Commerce");
    expect(mocks.manager).toHaveBeenCalledWith(
      expect.objectContaining({
        initialRoster: [{ clientId: "client-1", fullName: "Northwind Commerce" }],
        initialCommissionClients: [],
        backendLoadFailed: false,
        rosterLoadFailed: false,
        commissionLoadFailed: true,
      }),
    );
  });
});
