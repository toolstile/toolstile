// Reviewed, expiring exceptions for the production dependency audit. An advisory is
// accepted only when an unexpired exception with a reason names its advisory, package
// and installed version, and every install path ends in one of the exception's parents.

/** Returns the audit's advisories that no exception accepts. Throws on an expired or unexplained exception. */
export function unacceptedAdvisories(advisories, exceptions, now = new Date()) {
	for (const exception of exceptions)
		if (
			!exception.reason ||
			!/^\d{4}-\d{2}-\d{2}$/.test(exception.expires) ||
			!(new Date(`${exception.expires}T00:00:00Z`) > now)
		)
			throw new Error("Dependency exception missing rationale or expired");
	return Object.values(advisories).filter(
		(advisory) => !exceptions.some((exception) => accepts(exception, advisory)),
	);
}

function accepts(exception, advisory) {
	const parents = [exception.pathSuffix].flat();
	return (
		advisory.github_advisory_id === exception.advisory &&
		advisory.module_name === exception.package &&
		Array.isArray(advisory.findings) &&
		advisory.findings.length > 0 &&
		advisory.findings.every(
			(finding) =>
				finding.version === exception.version &&
				Array.isArray(finding.paths) &&
				finding.paths.length > 0 &&
				finding.paths.every((path) =>
					parents.some(
						(parent) =>
							typeof parent === "string" &&
							parent.startsWith(">") &&
							path.endsWith(parent),
					),
				),
		)
	);
}
