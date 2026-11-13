import {
	CheckCircleIcon,
	WarningCircleIcon,
	XIcon,
} from "@phosphor-icons/react";
import * as stylex from "@stylexjs/stylex";
import { useCallback, useEffect, useId, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { Toaster, toast } from "sonner";
import { useAppearance } from "./Appearance";
import {
	colors,
	elevation,
	geometry,
	size,
	space,
	text,
	typeScale,
} from "./tokens.stylex";

let ready = false;
const pending = new Map<
	string,
	{ message: string; kind: "success" | "error"; current(): boolean }
>();
function dismiss(id: string) {
	pending.delete(id);
	toast.dismiss(id);
}
function ToastReady() {
	useEffect(() => {
		ready = true;
		for (const [id, entry] of pending) {
			if (entry.current())
				toast[entry.kind](entry.message, {
					id,
					duration: entry.kind === "error" ? 8000 : 5000,
				});
		}
		pending.clear();
		return () => {
			ready = false;
			pending.clear();
		};
	}, []);
	return null;
}

/** One persistent host, including inside native dialogs' top layer. */
export function ToastViewport() {
	const { theme } = useAppearance();
	const [host, setHost] = useState<HTMLDivElement | null>(null);
	// Bottom-right would cover a dialog's footer actions, so toasts move to the top centre while
	// one is open, clear of the close button.
	const [overDialog, setOverDialog] = useState(false);
	useEffect(() => {
		const element = document.createElement("div");
		element.dataset.toastViewport = "";
		function position() {
			const dialogs = document.querySelectorAll<HTMLElement>(
				'dialog[open], [role="dialog"][aria-modal="true"]',
			);
			const dialog = dialogs.item(dialogs.length - 1);
			// A modal card keeps its entry animation's transform, which would make it the
			// toaster's containing block; its untransformed overlay keeps toasts on the viewport.
			const target = !dialog
				? document.body
				: dialog instanceof HTMLDialogElement
					? dialog
					: (dialog.parentElement ?? dialog);
			if (element.parentElement !== target) target.append(element);
			setOverDialog(target !== document.body);
			// ModalFrame may have made this owned body child inert before it moved.
			element.removeAttribute("inert");
		}
		position();
		setHost(element);
		const observer = new MutationObserver(position);
		observer.observe(document.body, {
			childList: true,
			subtree: true,
			attributes: true,
			attributeFilter: ["open"],
		});
		return () => {
			observer.disconnect();
			element.remove();
		};
	}, []);
	return host
		? createPortal(
				<>
					<Toaster
						theme={theme}
						position={overDialog ? "top-center" : "bottom-right"}
						duration={5000}
						visibleToasts={2}
						closeButton
						offset={20}
						mobileOffset={12}
						containerAriaLabel="Notifications"
						icons={{
							success: (
								<CheckCircleIcon size={16} {...stylex.props(s.success)} />
							),
							error: <WarningCircleIcon size={16} {...stylex.props(s.error)} />,
							close: <XIcon size={16} />,
						}}
						toastOptions={{
							unstyled: true,
							closeButtonAriaLabel: "Dismiss notification",
							classNames: {
								toast: stylex.props(s.toast).className,
								title: stylex.props(s.title).className,
								content: stylex.props(s.content).className,
								icon: stylex.props(s.icon).className,
								closeButton: stylex.props(s.close).className,
							},
						}}
					/>
					<ToastReady />
				</>,
				host,
			)
		: null;
}

/** Feedback belongs to one signed-in view; stale asynchronous work cannot cross it. */
export function useToastFeedback(scope: string) {
	const id = useId();
	const current = useRef({ scope, active: false });
	if (current.current.scope !== scope)
		current.current = { scope, active: false };
	const generation = current.current;
	useEffect(() => {
		generation.active = true;
		return () => {
			generation.active = false;
			dismiss(id);
		};
	}, [id, generation]);
	return useCallback(
		(message: string, kind: "success" | "error" = "success") => {
			if (
				typeof window === "undefined" ||
				current.current !== generation ||
				!generation.active
			)
				return;
			if (!message) {
				dismiss(id);
				return;
			}
			if (!ready) {
				pending.set(id, {
					message,
					kind,
					current: () => current.current === generation && generation.active,
				});
				return;
			}
			toast[kind](message, { id, duration: kind === "error" ? 8000 : 5000 });
		},
		[generation, id],
	);
}

const s = stylex.create({
	toast: {
		display: "flex",
		alignItems: "center",
		gap: space.s2,
		width: "var(--width)",
		minHeight: 48,
		paddingBlock: space.s2,
		paddingInlineStart: space.s3,
		paddingInlineEnd: `calc(${size.control} + ${space.s2})`,
		backgroundColor: colors.popover,
		color: colors.text,
		borderRadius: geometry.corner,
		boxShadow: elevation.medium,
		fontFamily: geometry.fontSans,
		fontSize: text.body,
		lineHeight: typeScale.leading13,
	},
	content: { minWidth: 0, flex: 1 },
	title: { fontWeight: 500, overflowWrap: "anywhere" },
	icon: { display: "flex", flexShrink: 0, color: colors.action },
	success: { color: colors.good },
	error: { color: colors.bad },
	close: {
		position: "absolute",
		right: 4,
		top: "50%",
		transform: "translateY(-50%)",
		width: size.control,
		height: size.control,
		display: "grid",
		placeItems: "center",
		padding: 0,
		cursor: "pointer",
		color: colors.muted,
		backgroundColor: {
			default: "transparent",
			":hover": colors.hover,
			":focus-visible": colors.hover,
		},
		borderWidth: 0,
		borderRadius: geometry.corner,
	},
});
