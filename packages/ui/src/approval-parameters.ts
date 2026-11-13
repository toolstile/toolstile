/** Make invisible characters explicit without changing the JSON value being reviewed. */
export function formatApprovalParameters(parameters: Record<string, unknown>) {
	let hasHiddenCharacters = false;
	const text = JSON.stringify(parameters, null, 2).replace(
		/[\p{Default_Ignorable_Code_Point}\p{Bidi_Control}\p{Cf}\p{Cc}\p{Zl}\p{Zp}\p{Zs}]/gu,
		(character) => {
			// These are structural formatting from JSON.stringify. Controls inside strings
			// are already JSON-escaped; ordinary spaces remain readable.
			if (character === " " || character === "\n" || character === "\t")
				return character;
			hasHiddenCharacters = true;
			// JSON uses UTF-16 escapes, including two escapes for an astral code point.
			return character
				.split("")
				.map((unit) => `\\u${unit.charCodeAt(0).toString(16).padStart(4, "0")}`)
				.join("");
		},
	);
	return { text, hasHiddenCharacters };
}
