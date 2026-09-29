// POST /api/team  { orgId, action: "add"|"role"|"remove", ... }  — workspace owner/admin manages their own team.
// Creates logins directly (no invite emails). Owners can't be changed here — only the platform admin transfers ownership.
import { handle, requireMember, HttpError } from "./_lib.js";
import { addMember, setMemberRole, removeMember } from "./_members.js";

export default handle(async (body, req) => {
  const { orgId, action } = body;
  const { user } = await requireMember(req, orgId, ["owner", "admin"], { requireActive: true });
  const me = { email: user.email, uid: user.uid };
  if (action === "add") {
    if (!["admin", "editor", "viewer"].includes(body.role)) throw new HttpError(400, "Role must be admin, editor or viewer.");
    return addMember(me, { orgId, email: body.email, password: body.password, role: body.role, name: body.name });
  }
  if (action === "role") {
    if (!["admin", "editor", "viewer"].includes(body.role)) throw new HttpError(400, "Role must be admin, editor or viewer.");
    if (body.uid === user.uid) throw new HttpError(400, "You can't change your own role.");
    return setMemberRole(me, { orgId, uid: body.uid, role: body.role });
  }
  if (action === "remove") {
    if (body.uid === user.uid) throw new HttpError(400, "You can't remove yourself.");
    return removeMember(me, { orgId, uid: body.uid });
  }
  throw new HttpError(400, "Unknown action");
});
