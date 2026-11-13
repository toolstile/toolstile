import nodemailer from "nodemailer";

/** Email is disabled unless all required SMTP settings are present. */
export function smtpDelivery(environment: Record<string, string | undefined>) {
	const host = environment.SMTP_HOST,
		from = environment.SMTP_FROM;
	if (!host || !from) return undefined;
	const port = Number(environment.SMTP_PORT ?? 465);
	if (!Number.isInteger(port) || port < 1 || port > 65535)
		throw new Error("Invalid SMTP_PORT");
	const transport = nodemailer.createTransport({
		host,
		port,
		secure: port === 465,
		requireTLS: port !== 465,
		auth: environment.SMTP_USER
			? { user: environment.SMTP_USER, pass: environment.SMTP_PASSWORD }
			: undefined,
		connectionTimeout: 10000,
		greetingTimeout: 10000,
		socketTimeout: 15000,
	});
	return async (message: { to: string; subject: string; text: string }) => {
		await transport.sendMail({ from, ...message });
	};
}
