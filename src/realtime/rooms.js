// Room names and "which rooms may this user join". The client never picks rooms: the server decides from the verified user.
const SUPER = 'super';
const lib = (libraryId) => `lib:${String(libraryId)}`;
const libFees = (libraryId) => `lib:${String(libraryId)}:fees`;
const branch = (libraryId, branchId) => `lib:${String(libraryId)}:branch:${String(branchId)}`;
const branchFees = (libraryId, branchId) => `lib:${String(libraryId)}:branch:${String(branchId)}:fees`;
const user = (userId) => `user:${String(userId)}`;

const idOf = (v) => String(v && v._id ? v._id : v);

/**
 * @param ctx { userType, userId, libraryId, permissions: string[], branchIds: any[] }
 * userType: superadmin | admin (owner) | staff | student
 */
const roomsFor = (ctx) => {
  const rooms = [user(ctx.userId)];
  if (ctx.userType === 'superadmin') { rooms.push(SUPER); return rooms; }
  if (ctx.userType === 'student' || !ctx.libraryId) return rooms;

  const lid = idOf(ctx.libraryId);
  const owner = ctx.userType === 'admin';
  const canFees = owner || (ctx.permissions || []).includes('fees.view');
  const branchIds = (ctx.branchIds || []).map(idOf);

  if (owner || branchIds.length === 0) {
    // unrestricted: everything of the library arrives through the library rooms
    rooms.push(lib(lid));
    if (canFees) rooms.push(libFees(lid));
  } else {
    // branch-limited staff: only their branches
    for (const b of branchIds) {
      rooms.push(branch(lid, b));
      if (canFees) rooms.push(branchFees(lid, b));
    }
  }
  return rooms;
};

module.exports = { SUPER, lib, libFees, branch, branchFees, user, roomsFor };
