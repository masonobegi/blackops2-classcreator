import { inferSchema, schemaHash, type SchemaNode } from '../schema/infer.ts';
import {
  diffResponseMeta,
  diffSchemas,
  maxSeverity,
  summarize,
  type Change,
  type Severity,
} from '../schema/diff.ts';
import type { ProbeOutcome } from './probe.ts';

export type EvalState = {
  baselineHash: string | null;
  baselineSchema: SchemaNode | null;
  baselineStatus: number | null;
  baselineContentType: string | null;
  baselineAt: number | null;
  pendingHash: string | null;
  pendingSchema: SchemaNode | null;
  pendingStatus: number | null;
  pendingContentType: string | null;
  pendingCount: number;
  consecutiveFailures: number;
  failureAlerted: boolean;
  lastOkAt: number | null;
};

export type EvalIncident = {
  kind: 'schema' | 'availability' | 'recovery';
  severity: Severity;
  summary: string;
  changes: Change[];
  fromHash: string | null;
  toHash: string | null;
};

export type EvalOutput = {
  state: EvalState;
  incident: EvalIncident | null;
  /** Structured schema of this response, for the snapshot row. */
  schemaHash: string | null;
  schemaJson: string | null;
  /** Human-readable trace of the decision, useful in logs and in the UI. */
  note: string;
};

export type EvalOptions = {
  ignorePaths: readonly string[];
  /** Consecutive identical observations required before we alert. Minimum 1. */
  confirmations: number;
  /** Consecutive probe failures before we raise an availability incident. */
  failureThreshold: number;
  now: number;
};

export function emptyState(): EvalState {
  return {
    baselineHash: null,
    baselineSchema: null,
    baselineStatus: null,
    baselineContentType: null,
    baselineAt: null,
    pendingHash: null,
    pendingSchema: null,
    pendingStatus: null,
    pendingContentType: null,
    pendingCount: 0,
    consecutiveFailures: 0,
    failureAlerted: false,
    lastOkAt: null,
  };
}

/**
 * Fingerprint of everything we consider part of the contract. Status code and
 * content type sit alongside the body shape because "200 JSON" turning into
 * "403 JSON" matters just as much as a renamed field.
 */
function contractHash(schema: SchemaNode, status: number, contentType: string): string {
  return schemaHash({
    t: 'object',
    props: {
      [`__status_${status}`]: { schema, optional: false },
      [`__ct_${contentType}`]: { schema: { t: 'null' }, optional: false },
    },
  });
}

/**
 * Decide what a single probe result means. Pure: no I/O, no clock, no database,
 * which is what makes the alerting rules testable instead of hopeful.
 *
 * The core rule is *confirmation before notification*. A change must be seen
 * `confirmations` times in a row before it becomes an incident. One flaky
 * response from a load-balanced upstream serving a stale node is the single
 * biggest source of false positives, and a monitoring tool that cries wolf
 * gets muted and then cancelled.
 */
export function evaluate(
  previous: EvalState,
  outcome: ProbeOutcome,
  options: EvalOptions,
): EvalOutput {
  const confirmations = Math.max(1, options.confirmations);
  const state: EvalState = { ...previous };

  // ---- probe failed: preserve everything we know, count towards availability
  if (!outcome.ok) {
    state.consecutiveFailures = previous.consecutiveFailures + 1;

    if (state.consecutiveFailures >= options.failureThreshold && !previous.failureAlerted) {
      state.failureAlerted = true;
      return {
        state,
        incident: {
          kind: 'availability',
          severity: 'warning',
          changes: [
            {
              path: '$',
              kind: 'unobservable',
              severity: 'warning',
              from: 'reachable',
              to: 'unreachable',
              message: outcome.error,
            },
          ],
          summary: `Check failed ${state.consecutiveFailures} times in a row: ${outcome.error}`,
          fromHash: previous.baselineHash,
          toHash: null,
        },
        schemaHash: null,
        schemaJson: null,
        note: `failure ${state.consecutiveFailures} (alerted)`,
      };
    }

    return {
      state,
      incident: null,
      schemaHash: null,
      schemaJson: null,
      note: `failure ${state.consecutiveFailures} of ${options.failureThreshold} before alerting`,
    };
  }

  // ---- probe succeeded
  const schema = inferSchema(outcome.body);
  const json = JSON.stringify(schema);
  const hash = contractHash(schema, outcome.status, outcome.contentType);
  const shapeHash = schemaHash(schema);

  const recovered = previous.failureAlerted;
  state.consecutiveFailures = 0;
  state.failureAlerted = false;
  state.lastOkAt = options.now;

  const recoveryIncident: EvalIncident | null = recovered
    ? {
        kind: 'recovery',
        severity: 'info',
        changes: [],
        summary: 'Endpoint is responding again',
        fromHash: previous.baselineHash,
        toHash: shapeHash,
      }
    : null;

  // First successful check: learn the shape, tell nobody.
  if (previous.baselineSchema === null || previous.baselineHash === null) {
    state.baselineHash = hash;
    state.baselineSchema = schema;
    state.baselineStatus = outcome.status;
    state.baselineContentType = outcome.contentType;
    state.baselineAt = options.now;
    clearPending(state);
    return {
      state,
      incident: recoveryIncident,
      schemaHash: shapeHash,
      schemaJson: json,
      note: 'baseline established',
    };
  }

  // Unchanged: the common case, and it must be cheap.
  if (hash === previous.baselineHash) {
    clearPending(state);
    return {
      state,
      incident: recoveryIncident,
      schemaHash: shapeHash,
      schemaJson: json,
      note: 'no change',
    };
  }

  // Something differs. Is it the same difference we saw last time?
  const seen = previous.pendingHash === hash ? previous.pendingCount + 1 : 1;
  if (seen < confirmations) {
    state.pendingHash = hash;
    state.pendingSchema = schema;
    state.pendingStatus = outcome.status;
    state.pendingContentType = outcome.contentType;
    state.pendingCount = seen;
    return {
      state,
      incident: recoveryIncident,
      schemaHash: shapeHash,
      schemaJson: json,
      note: `change seen ${seen} of ${confirmations} needed to confirm`,
    };
  }

  // Confirmed. Diff against the baseline and adopt the new shape either way, so
  // the same change is never reported twice.
  const changes = [
    ...diffResponseMeta(
      {
        status: previous.baselineStatus ?? outcome.status,
        contentType: previous.baselineContentType ?? outcome.contentType,
      },
      { status: outcome.status, contentType: outcome.contentType },
    ),
    ...diffSchemas(previous.baselineSchema, schema, options.ignorePaths),
  ];

  state.baselineHash = hash;
  state.baselineSchema = schema;
  state.baselineStatus = outcome.status;
  state.baselineContentType = outcome.contentType;
  state.baselineAt = options.now;
  clearPending(state);

  if (changes.length === 0) {
    // Everything that moved was on the ignore list. Adopt silently.
    return {
      state,
      incident: recoveryIncident,
      schemaHash: shapeHash,
      schemaJson: json,
      note: 'change confirmed but fully ignored by path rules',
    };
  }

  const previousShapeHash = schemaHash(previous.baselineSchema);
  return {
    state,
    incident: {
      kind: 'schema',
      severity: maxSeverity(changes),
      summary: summarize(changes),
      changes,
      fromHash: previousShapeHash,
      toHash: shapeHash,
    },
    schemaHash: shapeHash,
    schemaJson: json,
    note: `confirmed ${changes.length} change(s)`,
  };
}

function clearPending(state: EvalState): void {
  state.pendingHash = null;
  state.pendingSchema = null;
  state.pendingStatus = null;
  state.pendingContentType = null;
  state.pendingCount = 0;
}
