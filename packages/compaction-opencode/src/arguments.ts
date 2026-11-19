import { z } from "zod";

export const historyArguments = {
	operation: z.enum(["search", "read"]),
	query: z.string().max(1000).optional(),
	entryId: z.string().max(64).optional(),
	cursor: z.string().max(2000).optional(),
};
