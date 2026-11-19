import { describe, expect, it } from "vitest";
import {
	accountAuthContext,
	accountAuthHref,
	accountAuthSearch,
	safeLocalReturnTo,
	validateLocalReturnTo,
} from "../../../packages/ui/src/AccountNavigation";
import { legacyDashboardHref } from "./account-navigation";

describe("general account navigation", () => {
	it.each([
		"https://evil.test/app/connections",
		"//evil.test/path",
		"javascript:alert(1)",
		"https://toolstile.invalid/app/connections",
		"\\\\evil.test",
		"/\\evil.test",
		"/%5cevil.test",
		"/%2f%2fevil.test",
		"/%252f%252fevil.test",
		"/%25252525252fexample.com",
		"/%252525252561pp/activity",
		"/%25",
		"/\nevil.test",
		"/app/activity\u007f",
		"/app/\u00a0activity",
		"/app/\u2003activity",
		"/app/%2520activity",
		"/app/%2500activity",
		"/auth/sign-in",
		"/auth/sign-up?returnTo=%2Fauth%2Fsign-in",
		"/auth/device/../sign-in",
		"/auth/device/approve",
		"/auth/devices",
		"/AUTH/device",
		"/recover-account",
		"/RECOVER-ACCOUNT/code",
		"/AUTH/sign-in",
		"/API",
		"/MCP/tools",
		"/OAUTH/upstream/callback",
		"/.WELL-KNOWN/oauth-authorization-server",
		"/AUTHORIZE-AGENT",
		"/CONSENT-AGENT",
		"/app/../auth/sign-in",
		"/app/%252e%252e/%2561uth/sign-in",
		"/app/%252e%252e//example.com",
		"/%61uth/sign-in",
		"/%2525252561uth/sign-in",
		"/api/auth/sign-in/social",
		"/oauth/upstream/callback",
		"/authorize-agent?sig=opaque",
		"/app/connections?code=secret",
		"/app/activity?payload=secret",
		"/app/activity#token=secret",
		"/app/activity#capturedPayload=secret",
		"/%zz",
		"/app/%C0%AFactivity",
		"/app/%ED%A0%80",
		"/app/activity?query=%E0%A4%A",
		"/app/activity#%FF=recent",
	])("rejects unsafe or looping return destination %s", (value) => {
		expect(validateLocalReturnTo(value)).toBeUndefined();
		expect(safeLocalReturnTo(value)).toBe("/app/connections");
	});
	it.each([
		"/app/activity?pageSize=25&filter=failed&page=2#recent",
		"/app/activity?query=read%20tools&filter=one+two#results",
		"/app/activity?query=100%25&tag=%E2%9C%93#recent",
		"/app/%61ctivity?filter=%2f%2F&filter=failed#",
		"/app/connections/../activity?",
		"/app/%2e/activity",
		"/app/%2525252561ctivity",
		"/app/authors?tokenizer=ordinary#secretary",
		// The CLI approval page needs a signed-in account, so sign-in returns to it.
		"/auth/device?user_code=ABCD-EFGH&device_name=build-box&next=setup",
		"/",
	])("retains page, filters, anchors and exact bytes: %s", (target) => {
		expect(validateLocalReturnTo(target)).toBe(target);
		expect(safeLocalReturnTo(target)).toBe(target);
	});
	it.each([
		"password",
		"token",
		"access_token",
		"refresh_token",
		"id_token",
		"client_secret",
		"code",
		"secret",
		"sig",
		"invitationToken",
		"payload",
		"capturedPayload",
		"%74%4F%6Ben",
	])("rejects sensitive query and fragment keys: %s", (key) => {
		for (const separator of ["?", "#"]) {
			const target = `/app/activity${separator}filter=failed&${key}=`;
			expect(validateLocalReturnTo(target)).toBeUndefined();
			expect(safeLocalReturnTo(target)).toBe("/app/connections");
		}
	});
	it.each([undefined, null, false, 1, {}, [], ["/app/activity"], ""])(
		"keeps invalid input shapes behind the wrapper fallback: %j",
		(value) => {
			expect(validateLocalReturnTo(value)).toBeUndefined();
			expect(safeLocalReturnTo(value)).toBe("/app/connections");
			expect(safeLocalReturnTo(value, "/app/activity")).toBe("/app/activity");
		},
	);
	it("keeps the established wrapper limit with a bounded validator default", () => {
		const target = `/${"a".repeat(4095)}`;
		const longer = `${target}a`;
		expect(validateLocalReturnTo(target)).toBe(target);
		expect(validateLocalReturnTo(longer)).toBeUndefined();
		expect(validateLocalReturnTo(longer, 8192)).toBe(longer);
		expect(safeLocalReturnTo(longer)).toBe(longer);
		const maximum = `/${"a".repeat(8191)}`;
		expect(safeLocalReturnTo(maximum)).toBe(maximum);
		expect(safeLocalReturnTo(`${maximum}a`)).toBe("/app/connections");
		for (const maxLength of [0, -1, 1.5, Number.NaN, Number.POSITIVE_INFINITY])
			expect(validateLocalReturnTo("/", maxLength)).toBeUndefined();
	});
	it("validates unknown search and preserves only normal account context", () => {
		expect(
			accountAuthSearch({
				returnTo: "//evil.test",
				invite: ["bad"],
				email: "a@example.test",
				password: "hidden",
				authMode: "signup",
			}),
		).toEqual({
			returnTo: "/app/connections",
			invite: undefined,
			email: "a@example.test",
		});
	});
	it("preserves invitation/email context across account pages without reflecting arbitrary params", () => {
		const context = {
			returnTo: "/app/activity?pageSize=25&filter=failed",
			invite: "fixture+invitation",
			email: "a+b@example.test",
		};
		for (const page of ["sign-in", "sign-up", "recover-account"] as const) {
			const url = new URL(accountAuthHref(page, context), "https://local.test");
			expect(url.pathname).toBe(`/auth/${page}`);
			expect(accountAuthSearch(Object.fromEntries(url.searchParams))).toEqual(
				context,
			);
		}
	});
	it("extracts account context and never nests invitation or protocol secrets in returnTo", () => {
		const context = accountAuthContext(
			"/app/activity?pageSize=25&filter=failed&invite=fixture&email=a%40example.test&authMode=signup&code=hidden",
		);
		expect(context).toEqual({
			returnTo: "/app/activity?pageSize=25&filter=failed",
			invite: "fixture",
			email: "a@example.test",
		});
	});
	it("removes all sensitive context keys before constructing the return destination", () => {
		expect(
			accountAuthContext(
				"/app/activity?filter=failed&secret=hidden&sig=hidden&invitationToken=hidden",
			).returnTo,
		).toBe("/app/activity?filter=failed");
	});
	it("redirects legacy pages with safe navigation state and drops old dialog selection", () => {
		expect(
			legacyDashboardHref(
				"/activity",
				"?filter=failed&page=2&dialog=debug&agentId=old&pageSize=25&code=hidden",
			),
		).toBe("/app/activity?filter=failed&page=2&pageSize=25");
		expect(legacyDashboardHref("/instance", "")).toBe("/app/settings/instance");
	});
});
