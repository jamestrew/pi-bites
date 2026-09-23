// Tests must load assets from their local Pi dependency, not the launching Pi installation.
delete process.env.PI_PACKAGE_DIR;

export default {};
