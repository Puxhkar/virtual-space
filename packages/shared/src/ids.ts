import * as z from "zod";

/**
 * Branded identifiers.
 *
 * Every id is a uuid at runtime, but branded at the type level so an OfficeId
 * can never be passed where a UserId is expected. This is cheap insurance on a
 * codebase where org scoping is a security boundary (CLAUDE.md §13).
 */

export const OrgIdSchema = z.uuid().brand<"OrgId">();
export type OrgId = z.infer<typeof OrgIdSchema>;

export const UserIdSchema = z.uuid().brand<"UserId">();
export type UserId = z.infer<typeof UserIdSchema>;

export const OfficeIdSchema = z.uuid().brand<"OfficeId">();
export type OfficeId = z.infer<typeof OfficeIdSchema>;

export const ZoneIdSchema = z.uuid().brand<"ZoneId">();
export type ZoneId = z.infer<typeof ZoneIdSchema>;

export const MapIdSchema = z.uuid().brand<"MapId">();
export type MapId = z.infer<typeof MapIdSchema>;
