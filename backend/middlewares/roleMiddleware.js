const checkPermission = (moduleName, requiredAccess) => {
  return (req, res, next) => {
    const permission = req.admin.permissions.find(p => p.module === moduleName);

    if (!permission) {
      return res.status(403).json({ error: "Permission denied" });
    }

    // VIEW access is valid if user has VIEW or EDIT
    if (requiredAccess === "VIEW" && (permission.access === "VIEW" || permission.access === "EDIT")) {
      return next();
    }

    // EDIT access is valid only if user has EDIT
    if (requiredAccess === "EDIT" && permission.access === "EDIT") {
      return next();
    }

    return res.status(403).json({ error: "Permission denied" });
  };
};

module.exports = {
  checkPermission,
};
