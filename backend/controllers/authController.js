// const UserService = require("../services/UserService");
// const { jwtGenerator, jwtSignGenerator } = require("../utils/jwt");
// const bcrypt = require("bcryptjs");
// const { 
//     generateOtp, 
//     sendOtpToEmail, 
//     sendMessageAsSMS, 
//     sendMessageToWhatsapp } = require("../utils/otp");

// class AuthController{
//     static async register(req, res){
//         const { email, phone, name } = req.body;
//         const lowerCaseEmail = email ? email.toLowerCase() : null;

//         const filter = (phone ? {phone} : {email: lowerCaseEmail});
//         const data = await UserService.getUser(filter);
//         if(data) return res.status(400).json({message:"User Already Exists", statusCode: 400});
//         const hassPassword = bcrypt.hashSync(req.body.password,8);
//         const tokenWith = phone ? phone : lowerCaseEmail;
//         const token = jwtSignGenerator(tokenWith);
//         const today = new Date();
//         const fourDigitOtp = generateOtp(4);
//         (lowerCaseEmail && lowerCaseEmail !== "") && sendOtpToEmail(fourDigitOtp, lowerCaseEmail, name);
//         (phone && phone !== "") && sendMessageToWhatsapp(fourDigitOtp, phone);
//         const userDetails = {
//             name: name,
//             phone: phone,
//             email: lowerCaseEmail,
//             password: hassPassword,
//             token: token,
//             otp: fourDigitOtp,
//             createdBy: today,
//             isVerified: false
//         }
//         try{
//             await UserService.registerNewUser(userDetails);
//             return res.status(201).json({message:"User Resgistered But Not Verified", statusCode: 201})
//         }catch(err){
//             console.log("Error :", err);
//         }
//     }
//     static async login(req, res){
//         const { email, phone } = req.body;
//         const lowerCaseEmail = email ? email.toLowerCase() : null;

//         const filter = (phone ? {phone} : {email: lowerCaseEmail});
//         const data = await UserService.getUser(filter);

//         if(!data) return res.status(404).json({message:"User Not Found"});

//         const fourDigitOtp = generateOtp(4);
//         (lowerCaseEmail && lowerCaseEmail !== "") && sendOtpToEmail(fourDigitOtp, lowerCaseEmail, data.name);
//         (phone && phone !== "") && sendMessageToWhatsapp(fourDigitOtp, phone);
//         await UserService.updateOtp({_id:data._id, otp:fourDigitOtp, isVerified: data.isVerified, registrationId: data.registrationId})
//         if(!data.isVerified){
//             return res.status(200).json({message:"User Unverified", statusCode: 200});
//         }
//         return res.status(200).json({message:"User Verified", statusCode: 200});
//     }
//     static async verifyCode(req, res){
//         const { email, phone } = req.body;
//         const lowerCaseEmail = email ? email.toLowerCase() : null;

//         const filter = (phone ? {phone} : {email: lowerCaseEmail});
//         const data = await UserService.getUser(filter);

//         if(!data) return res.status(404).json({message:"User Not Found"});
//         if(data.otp !== req.body.otp) return res.status(200).json({message:"Incorrect OTP", statusCode: 400});

//         if(req.body.otpType === "register"){
//             const registrationId = "thriftyx_"+generateOtp(6);
//             if(data.otp !== req.body.otp) return res.status(200).json({message:"Incorrect OTP", statusCode: 400});
//             const token = jwtGenerator({_id:data._id});
//             await UserService.updateToken({_id:data._id,token});
//             await UserService.updateOtp({_id:data._id,otp:null,isVerified:true,registrationId});
//             const user = {
//                 _id: data._id,
//                 name: data.name,
//                 phone: data.phone,
//                 email: data.email,
//                 isVerified: !data.isVerified,
//                 registrationId: registrationId
//             }
//             return res.status(200).json({message:"Registration Successful", user, token, statusCode: 200})
//         }
//         if(req.body.otpType === "login"){
//             const token = jwtGenerator({_id:data._id});
//             await UserService.updateToken({_id:data._id, token});
//             await UserService.updateOtp({_id:data._id, otp:null, isVerified: data.isVerified, registrationId: data.registrationId});
//             const user = {
//                 _id: data._id,
//                 DOB: data.DOB,
//                 city: data.city,
//                 name: data.name,
//                 phone: data.phone,
//                 email: data.email,
//                 gender: data.gender,
//                 isVerified: data.isVerified,
//                 registrationId: data.registrationId,
//                 profilePicture: data.profilePicture,
//             }
//             return res.status(200).json({message:"Login Success", user, token, statusCode: 200})
//         }
//         else if(req.body.otpType === "forgot"){
//             if(data.forgotCode !== req.body.otp) return res.status(400).json({message:"Incorrect OTP",statusCode: 400});
//             await UserService.updateForgotCode({_id:data._id,forgotCode:null});
//             return res.status(200).json({message:"OTP Verified Successfully", statusCode: 200});
//         }
//     }
//     static async resendOTP(req, res) {
//         const { email, phone } = req.body;
//         const lowerCaseEmail = email ? email.toLowerCase() : null;

//         const filter = (phone ? {phone} : {email: lowerCaseEmail});
//         const data = await UserService.getUser(filter);
    
//         if(!data) return res.status(404).json({message:"User Not Found"});
//         const fourDigitOtp = generateOtp(4);
//         (lowerCaseEmail && lowerCaseEmail !== "") && sendOtpToEmail(fourDigitOtp, lowerCaseEmail, data.name);
//         (phone && phone !== "") && sendMessageToWhatsapp(fourDigitOtp, phone);
//         if(!data.isVerified){
//             await UserService.updateOtp({_id:data._id,otp: fourDigitOtp, isVerified: data.isVerified, registrationId: data.registrationId});
//             return res.status(200).json({message:"New OTP Sent", statusCode: 200});
//         }
//         await UserService.updateForgotCode({_id:data._id, forgotCode:fourDigitOtp});
//         return res.status(200).json({message:"New OTP Sent", statusCode: 200});
//     }
//     static async forgotPassword(req, res){
//         const { email } = req.body;
//         const lowerCaseEmail = email ? email.toLowerCase() : null;
//         const data = await UserService.getUser({$or: [{phone:req.body.phone},{email:lowerCaseEmail}]});
//         if(!data) return res.status(404).json({message:"User Not Found"});
//         const fourDigitOtp = generateOtp(4);
//         sendOtpToEmail(fourDigitOtp, lowerCaseEmail, data.name);
//         await UserService.updateForgotCode({_id:data._id, forgotCode: fourDigitOtp});
//         return res.status(200).json({message:"OTP Sent To Your Registered Email", statusCode: 200});
//     }
//     static async updatePassword(req, res){
//         const { email } = req.body;
//         const lowerCaseEmail = email ? email.toLowerCase() : null;
//         const data = await UserService.getUser({$or: [{phone:req.body.phone},{email:lowerCaseEmail}]});
//         if(!data) return res.status(404).json({message:"User Not Found"});
//         if(data.forgotCode !== null) return res.status(404).json({message:"Email Not Verified"})
//         const passIsValid = bcrypt.compareSync(req.body.password, data.password);
//         if(passIsValid) return res.status(400).json({message: "Password Must Be Different From Previous Password"});
//         const hassPassword = bcrypt.hashSync(req.body.password, 8);
//         await UserService.updatePassword({_id:data._id,password:hassPassword});
//         res.status(200).json({message: "Password Reset Successfully", statusCode: 200});
//     }
// }
// module.exports = AuthController;