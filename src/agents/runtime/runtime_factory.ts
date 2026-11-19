// Shared admission errors and submission envelopes, without a runtime factory.
import { buildSubmission, PiRPCError } from "./pi_protocol";
export const piRuntimeErrors = {
  runtimeError: PiRPCError,
  buildSubmission,
};
