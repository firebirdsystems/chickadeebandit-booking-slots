import { describe, it, expect } from "vitest";
import { shareFailureLine } from "../src/logic.js";

const err = (props, message = "hub text") => Object.assign(new Error(message), props);
const words = { action: "create the share link", thing: "booking sheet" };

describe("shareFailureLine", () => {
  it("names the active-link cap without asking for a retry", () => {
    expect(shareFailureLine(err({ status: 402, missingCapability: true }), words))
      .toBe("Too many share links are active — revoke one first.");
  });
  it("names a refusal and a removed item", () => {
    expect(shareFailureLine(err({ status: 403 }, "Only household admins can share this item type"), words))
      .toBe("You don’t have permission to create the share link.");
    expect(shareFailureLine(err({ status: 404 }, "Item not found"), words))
      .toBe("This booking sheet has been removed.");
  });
  it("asks for a retry only when retrying can work", () => {
    for (const e of [err({}), err({ status: 400 }), err({ status: 409 }), err({ status: 500 }), err({ status: 503 }), new TypeError("Failed to fetch"), undefined]) {
      expect(shareFailureLine(e, { action: "revoke the share link", thing: "booking sheet" }))
        .toBe("Couldn’t revoke the share link — try again.");
    }
  });
  it("keeps the retry for the create's 409, which also answers a failed mint", () => {
    expect(shareFailureLine(err({ status: 409 }, "D1_ERROR: boom"), words)).toBe("Couldn’t create the share link — try again.");
  });
  it("names the hub's coded refusals", () => {
    expect(shareFailureLine(err({ status: 409, code: "share_link_limit" }, "Active share link limit reached (100)"), words))
      .toBe("Too many share links are active — revoke one first.");
    expect(shareFailureLine(err({ status: 400, code: "password_too_short" }, "Password must be at least 6 characters"), words))
      .toBe("The password needs at least 6 characters.");
    expect(shareFailureLine(err({ status: 403, code: "not_owner" }, "Only the member who created this link (or an admin) can revoke it"), { action: "revoke the share link", thing: "x" }))
      .toBe("You don’t have permission to revoke the share link.");
  });
  it("never shows the hub's text", () => {
    expect(shareFailureLine(err({ status: 500 }, "D1_ERROR: boom"), words)).not.toMatch(/D1_ERROR|hub text/);
  });
});
