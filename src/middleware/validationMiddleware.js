//utils
const statusCode = require("../utils/httpResponseCode");
const { responseHandler } = require("../utils/responseHandler");
exports.validationMiddleware = (validationSchema) => {
    return (req, res, next) => {
        const { error } = validationSchema.validate(req.body,{ abortEarly: false }); // Ensure all errors are captured
        
        if (error) {
            console.log("error details",error.details);
            return responseHandler({
                res,
                code: statusCode.DATAMISSING,
                message: error.details[0].message, // Send first validation error message
                error: error.details.map(detail => detail.message), // Send all validation errors in array
            });
        }
        
        next();
    };
};