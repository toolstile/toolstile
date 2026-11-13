import { useNavigate } from "@tanstack/react-router";
import { AuthLoading } from "@toolstile/ui/auth-loading";
import { useEffect, useRef } from "react";
/** Keep the auth loader visible while Router follows an already-validated local href. */
export function AccountRedirect({ href }: { href: string }) {
	const navigate = useNavigate();
	// The previous route may render again while Router loads the destination.
	const destination = useRef(href).current;
	useEffect(() => {
		void navigate({ href: destination, replace: true });
	}, [destination, navigate]);
	return <AuthLoading />;
}
