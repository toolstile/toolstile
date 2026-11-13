import { XIcon } from "@phosphor-icons/react";
import * as stylex from "@stylexjs/stylex";
import {
	type ReactNode,
	useId,
	useLayoutEffect,
	useRef,
	useState,
} from "react";
import { createPortal } from "react-dom";
import { controls } from "./Control.styles";
import { popupStyles } from "./Popup.styles";
import {
	colors,
	elevation,
	geometry,
	size,
	space,
	text,
	typeScale,
} from "./tokens.stylex";

type ModalFrameHeading =
	| {
			/** The caller renders its own heading with this id. */
			labelledBy: string;
			title?: never;
			description?: never;
	  }
	| {
			/** Renders a titled card with a close button around the children. */
			title: ReactNode;
			/** One muted line under the title; longer copy belongs in the body. */
			description?: string;
			labelledBy?: never;
	  };

/** Open modal overlays, topmost last; only the top one handles keys and stays interactive. */
const layers: HTMLElement[] = [];
/** Body children this module made inert, so closing never clears someone else's `inert`. */
const inerted = new Set<Element>();
let pageOverflow = "";

const focusableSelector = [
	"a[href]",
	"button:not([disabled])",
	"input:not([disabled]):not([type='hidden'])",
	"select:not([disabled])",
	"textarea:not([disabled])",
	"summary",
	"[contenteditable]:not([contenteditable='false'])",
	"[tabindex]",
].join(",");

/** Base UI portals select popups and menus to the body; they must stay usable above a modal. */
const popupLayer = "[data-base-ui-portal]";

function tabbable(root: HTMLElement) {
	return Array.from(
		root.querySelectorAll<HTMLElement>(focusableSelector),
	).filter(
		(element) =>
			element.tabIndex >= 0 &&
			!element.hasAttribute("data-base-ui-focus-guard") &&
			!element.closest("[hidden], [inert]") &&
			element.getClientRects().length > 0,
	);
}

/**
 * The element to refocus on close. A menu item that opened the dialog unmounts with its menu,
 * so fall back to the trigger that controls that popup.
 */
function returnTarget() {
	const active = document.activeElement;
	const popup = active?.closest(
		`${popupLayer} [role="menu"][id], ${popupLayer} [role="listbox"][id]`,
	);
	if (!popup) return active;
	return (
		document.querySelector(`[aria-controls="${CSS.escape(popup.id)}"]`) ??
		active
	);
}

/** Makes every body child except the top overlay and popup layers inert, and locks page scroll. */
function syncLayers() {
	for (const element of inerted) element.removeAttribute("inert");
	inerted.clear();
	const top = layers.at(-1);
	if (!top) {
		document.documentElement.style.overflow = pageOverflow;
		return;
	}
	for (const element of Array.from(document.body.children)) {
		if (
			element === top ||
			element.hasAttribute("inert") ||
			element.matches(`script, style, link, template, ${popupLayer}`)
		)
			continue;
		element.setAttribute("inert", "");
		inerted.add(element);
	}
}

/**
 * Modal dialog rendered in a body portal over a dimmed backdrop. Open state belongs to the
 * caller's local UI state: the dialog never closes itself, it asks through `onClose` (Escape,
 * a press on the backdrop or the close button) and stays open until the caller unmounts it.
 * Focus starts on the first `[data-autofocus]` element (otherwise the first focusable one, then
 * the dialog), Tab cycles inside, the rest of the page is inert, and focus returns to the
 * previously focused element afterwards. Browser Back or Forward to another path also asks to
 * close, so a dialog never stays open over a page it does not belong to.
 */
export function ModalFrame({
	children,
	describedBy,
	busy = false,
	closeLabel = "Close dialog",
	width,
	onClose,
	...heading
}: ModalFrameHeading & {
	children: ReactNode;
	describedBy?: string;
	/** Blocks Escape, backdrop presses and the close button, and marks the dialog busy. */
	busy?: boolean;
	closeLabel?: string;
	/** Card width: sm for short confirmations, md for single forms; titled cards default to lg. */
	width?: "sm" | "md" | "lg";
	onClose(): void;
}) {
	const overlayRef = useRef<HTMLDivElement>(null);
	const dialogRef = useRef<HTMLDivElement>(null);
	const titleId = useId();
	const descriptionId = useId();
	const close = useRef(onClose);
	close.current = onClose;
	const blocked = useRef(busy);
	blocked.current = busy;
	// Captured during the first render, before any child can take focus in the commit.
	const [opener] = useState(() =>
		typeof document === "undefined" ? null : returnTarget(),
	);
	useLayoutEffect(() => {
		const overlay = overlayRef.current;
		const dialog = dialogRef.current;
		if (!overlay || !dialog) return;
		if (!layers.length) {
			pageOverflow = document.documentElement.style.overflow;
			document.documentElement.style.overflow = "hidden";
		}
		layers.push(overlay);
		syncLayers();
		const initial = () =>
			dialog.querySelector<HTMLElement>("[data-autofocus]") ??
			tabbable(dialog)[0] ??
			dialog;
		initial().focus({ preventScroll: true });
		const isTop = () => layers.at(-1) === overlay;
		function onKeyDown(event: KeyboardEvent) {
			// Registered on window so popups inside (Base UI handles Escape on the document and
			// prevents it) and fields that consume Escape get the key first.
			if (!isTop() || event.defaultPrevented || event.isComposing || !dialog)
				return;
			const target = event.target;
			const inside =
				target === document.body ||
				(target instanceof Node && overlay?.contains(target));
			if (!inside) return;
			if (event.key === "Escape") {
				event.preventDefault();
				if (!blocked.current) close.current();
				return;
			}
			if (event.key !== "Tab") return;
			const items = tabbable(dialog);
			const active = document.activeElement;
			if (!items.length || !(active instanceof Node)) {
				event.preventDefault();
				dialog.focus({ preventScroll: true });
				return;
			}
			// Wrap only when no tabbable element remains in the pressed direction; ancestors
			// precede and descendants follow, matching sequential focus order.
			const before = (a: Node, b: Node) =>
				Boolean(
					a.compareDocumentPosition(b) & Node.DOCUMENT_POSITION_FOLLOWING,
				);
			const wrapTo = event.shiftKey
				? items.some((item) => before(item, active))
					? null
					: items.at(-1)
				: items.some((item) => before(active, item))
					? null
					: items[0];
			if (wrapTo) {
				event.preventDefault();
				wrapTo.focus();
			}
		}
		function onFocusIn(event: FocusEvent) {
			const target = event.target;
			if (
				!isTop() ||
				!(target instanceof Element) ||
				overlay?.contains(target) ||
				target.closest(popupLayer)
			)
				return;
			initial().focus({ preventScroll: true });
		}
		// Both ends of a press must land on the backdrop itself, so a text selection dragged out
		// of the card does not dismiss it. Native listeners also ignore clicks that React would
		// bubble here from portalled popups.
		let pressedBackdrop = false;
		function onPointerDown(event: PointerEvent) {
			pressedBackdrop = event.target === overlay;
		}
		function onClick(event: MouseEvent) {
			const outside = pressedBackdrop && event.target === overlay;
			pressedBackdrop = false;
			if (outside && isTop() && !blocked.current) close.current();
		}
		// Search-only history entries (filters typed underneath) keep the dialog open.
		const path = location.pathname;
		function onPopState() {
			if (location.pathname !== path && !blocked.current) close.current();
		}
		window.addEventListener("keydown", onKeyDown);
		window.addEventListener("popstate", onPopState);
		document.addEventListener("focusin", onFocusIn);
		overlay.addEventListener("pointerdown", onPointerDown);
		overlay.addEventListener("click", onClick);
		return () => {
			window.removeEventListener("keydown", onKeyDown);
			window.removeEventListener("popstate", onPopState);
			document.removeEventListener("focusin", onFocusIn);
			overlay.removeEventListener("pointerdown", onPointerDown);
			overlay.removeEventListener("click", onClick);
			layers.splice(layers.indexOf(overlay), 1);
			syncLayers();
			if (opener instanceof HTMLElement && opener.isConnected)
				opener.focus({ preventScroll: true });
		};
	}, [opener]);
	if (typeof document === "undefined") return null;
	const titled = heading.title !== undefined;
	const description = titled ? heading.description : undefined;
	return createPortal(
		<div
			ref={overlayRef}
			{...stylex.props(
				local.overlay,
				titled ? local.overlayTitled : local.overlayDefault,
				popupStyles.backdrop,
			)}
		>
			<div
				ref={dialogRef}
				role="dialog"
				aria-modal="true"
				tabIndex={-1}
				{...stylex.props(
					local.dialog,
					widths[width ?? (titled ? "lg" : "md")],
					popupStyles.dialogEnter,
				)}
				aria-labelledby={titled ? titleId : heading.labelledBy}
				aria-describedby={
					describedBy ?? (description ? descriptionId : undefined)
				}
				aria-busy={busy || undefined}
			>
				{titled ? (
					<div {...stylex.props(local.card)}>
						<div {...stylex.props(local.header)}>
							<div {...stylex.props(local.heading)}>
								<h2 id={titleId} {...stylex.props(local.title)}>
									{heading.title}
								</h2>
								{description && (
									<p
										id={descriptionId}
										title={description}
										{...stylex.props(local.description)}
									>
										{description}
									</p>
								)}
							</div>
							<button
								type="button"
								aria-label={closeLabel}
								{...stylex.props(
									controls.button,
									controls.quiet,
									controls.iconOnly,
								)}
								disabled={busy}
								onClick={onClose}
							>
								<XIcon size={18} />
							</button>
						</div>
						{children}
					</div>
				) : (
					children
				)}
			</div>
		</div>,
		document.body,
	);
}

const touch = "@media (max-width: 760px)";

const widths = stylex.create({
	sm: { width: `min(${size.dialogSm}, 100%)` },
	md: { width: `min(${size.dialogMd}, 100%)` },
	lg: { width: `min(${size.dialogLg}, 100%)` },
});

const local = stylex.create({
	overlay: {
		position: "fixed",
		inset: 0,
		zIndex: 1000,
		display: "flex",
		overflowY: "auto",
		overscrollBehavior: "contain",
	},
	overlayDefault: { padding: { default: 24, [touch]: 12 } },
	overlayTitled: { padding: { default: 24, [touch]: 12 } },
	dialog: {
		// Auto margins centre the dialog without clipping its top when it outgrows the viewport.
		margin: "auto",
		minWidth: 0,
		color: colors.text,
		outline: "none",
	},
	card: {
		display: "flex",
		flexDirection: "column",
		gap: space.s4,
		minWidth: 0,
		maxHeight: {
			default: "calc(100dvh - 48px)",
			[touch]: "calc(100dvh - 24px)",
		},
		overflowY: "auto",
		overscrollBehavior: "contain",
		padding: { default: space.s5, [touch]: space.s4 },
		backgroundColor: colors.popover,
		color: colors.text,
		borderRadius: geometry.corner,
		boxShadow: elevation.high,
		fontFamily: geometry.fontSans,
	},
	/**
	 * Stays visible while a long card scrolls. Sticky offsets start inside the card's padding, so
	 * the negative top and margin pin it to the card edge and its own padding covers the gap.
	 */
	header: {
		position: "sticky",
		top: {
			default: `calc(-1 * ${space.s5})`,
			[touch]: `calc(-1 * ${space.s4})`,
		},
		zIndex: 1,
		display: "flex",
		alignItems: "flex-start",
		justifyContent: "space-between",
		gap: space.s4,
		minWidth: 0,
		marginBlockStart: {
			default: `calc(-1 * ${space.s5})`,
			[touch]: `calc(-1 * ${space.s4})`,
		},
		paddingBlockStart: { default: space.s5, [touch]: space.s4 },
		marginBlockEnd: `calc(-1 * ${space.s2})`,
		paddingBlockEnd: space.s2,
		backgroundColor: colors.popover,
	},
	heading: {
		display: "flex",
		flexDirection: "column",
		gap: space.s0_5,
		flex: "1 1 240px",
		minWidth: 0,
	},
	title: {
		fontSize: text.dialogTitle,
		lineHeight: text.dialogTitleLeading,
		fontWeight: 600,
		margin: 0,
		overflowWrap: "anywhere",
	},
	/** Up to two lines; the full text stays in the title attribute. */
	description: {
		color: colors.muted,
		margin: 0,
		fontSize: text.body,
		lineHeight: typeScale.leading13,
		overflow: "hidden",
		display: "-webkit-box",
		WebkitBoxOrient: "vertical",
		WebkitLineClamp: 2,
		overflowWrap: "anywhere",
	},
});
