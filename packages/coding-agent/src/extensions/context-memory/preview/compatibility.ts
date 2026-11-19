/** Exact official hosts validated for the independent extension, newest first. */
export const SUPPORTED_PI_VERSIONS: readonly string[] = Object.freeze(["1.5.2", "1.4.0", "1.3.0", "1.2.0", "1.1.0"]);
export const PRIMARY_PI_VERSION = SUPPORTED_PI_VERSIONS[0];
/** The exact reviewed hosts, as displayed in notices and errors. */
export const SUPPORTED_PI_LABEL =
	SUPPORTED_PI_VERSIONS.length < 2
		? PRIMARY_PI_VERSION
		: `${SUPPORTED_PI_VERSIONS.slice(0, -1).join(", ")} or ${SUPPORTED_PI_VERSIONS.at(-1)}`;

export function supportsPi(version: string): boolean {
	return SUPPORTED_PI_VERSIONS.includes(version);
}
