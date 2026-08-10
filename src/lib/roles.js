// Moderator and setter are peers (same permission level, different label);
// admin implies both, so it's checked first.
export function roleOf(user) {
  if (user.isAdmin) return "admin";
  if (user.isModerator) return "moderator";
  if (user.isSetter) return "setter";
  return "member";
}
