const jwt = require('jsonwebtoken');

exports.generateAdminToken = (admin) => {
    const payload = {
        adminId: admin._id,
        role: admin.role,
    };
    const token = jwt.sign(payload, process.env.JWT_SECRET);
    return token;
}
exports.generateUserToken = (user) => {
    const payload = {
        userId: user._id,
        role: user.role,
    }
    return jwt.sign(payload, process.env.JWT_SECRET);
}
// use like this
// const token = generateUserToken(user);

exports.generateDriverToken = (driver) => {
    const payload = {
        driverId: driver._id,
    }
    return jwt.sign(payload, process.env.JWT_SECRET);
}