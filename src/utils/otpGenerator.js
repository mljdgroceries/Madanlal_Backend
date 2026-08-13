exports.generateOtp = () => {
    return Math.floor(10000 + Math.random() * 90000).toString();//5 digits otp
}