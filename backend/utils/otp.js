const axios = require('axios');
const twilio = require('twilio');
const nodemailer  = require('nodemailer');
const { capitalizeText } = require('./capitalizeText');

const accountSid = 'AC7c8d13036d9dbc79c98bae643f37ca83';
const authToken = 'cae2cfae739c2b5a70eb5398a1b0663e';

const client = new twilio(accountSid, authToken);

const generateOtp = (otpLength) => {
    let digits = "0123456789";
    let otp = "";
    for(let i = 0; i < otpLength; i++) {
        otp += digits[Math.floor(Math.random()*10)];
    }
    return otp;
}
const sendOtpToEmail = async(otp, email, name) => {

    const message = `Dear ${capitalizeText(name)},\n\nYour ThriftyX OTP is ${otp}. Do not share this OTP with anyone.\n\nThanks,\nTeam Thrifty X`;

    const transporter = nodemailer.createTransport({
        host: 'live.smtp.mailtrap.io',
        port: 587,
        secure: false,
        auth: {
            user: 'api',
            pass: '558f6b5336ec2cf46825fe6e9baec965'
        }
    });

    const mailOptions = {
        from: 'Thrifty X  no-reply@thriftyx.com',
        to: email,
        subject: 'ThriftyX OTP',
        text: message 
    };

    transporter.sendMail(mailOptions, function(error, info){
        if (error) {
            console.log(error);
        } else {
            console.log('Email sent: ' + info.response);
        }
    });
}
const sendMessageAsSMS = async(otp, number) => {
    const apiKey = "NzQzMzY5NTU1MDRhNzY2Njc2NmQ0MzQ4NzM1MjM0MzA=";

    const phone = number //array(918123456789, 918987654321);
    const sender = "600010";

    const msg = `Hi there, thank you for sending your first test message from Textlocal. Get 20% off today with our code: ${otp}.`;

    const params = new URLSearchParams();

    params.append("numbers", [parseInt("91" + phone)]);
    params.append("message", msg);

    try{
        const httpClient = axios.create({
            baseURL: "https://api.textlocal.in/",
            params: {
                apiKey: apiKey,
                sender: sender
            }
        })
        const data = await httpClient.post("send", params);
        console.log("data====>",data.data);
    }
    catch(err){
        console.log("Error===>",err.error);
    }
}
const sendMessageToWhatsapp = async(otp, number) => {
    await client.messages.create({
        contentSid: 'HX1fc52a39da832912c836d710b7261d23',
        messagingServiceSid: "MG2cf4130acb3803d86817286de4b4519f",
        contentVariables: JSON.stringify({ 1: otp }),
        to: `whatsapp:+91${number}`
    })
    .then(message => console.log(message.sid))
    .catch(err => console.error("Error sending message:", err));
}
module.exports = {
    generateOtp,
    sendOtpToEmail,
    sendMessageAsSMS,
    sendMessageToWhatsapp
}