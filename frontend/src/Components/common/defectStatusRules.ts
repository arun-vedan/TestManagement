// WP-F23 final tidy -- one home for the "is this defect still open" rule,
// which had drifted into two verbatim copies (ReleaseDetail.tsx's release
// lens grid and TraceabilityMatrixSection.tsx's matrix). Both agreed, so
// nothing was broken yet; the cost of two copies is that the next change to
// one view's notion of "resolved" silently leaves the other disagreeing
// about the same defect. That is the failure mode this package has now met
// three times in other shapes -- a rule expressed twice drifts -- so it is
// worth a file.
//
// Lives beside StatusChip.tsx because that is the shared status primitive
// both consumers already relate to, rather than inventing a top-level utils
// directory for a single predicate.

// istatusservice's real vocabulary (DefectStatus.tsx's own header comment:
// "New/Open/Fixed/Rejected/Deffered/Retest/Re-open/Closed today") has one
// terminal state, 'Closed' -- every other value still needs eyes on it.
// Matched case-insensitively because defectService stores this as a free
// string, not an enum, so casing is whatever the writer typed.
export function isUnresolvedDefectStatus(status: string): boolean {
  return status.trim().toLowerCase() !== 'closed';
}
