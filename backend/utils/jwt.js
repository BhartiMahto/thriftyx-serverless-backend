const jwt = require('jsonwebtoken');

const jwtGenerator = (payload) => {
    try{
        return jwt.sign(payload,process.env.JWT_SECRET, {expiresIn:"24h"});
    }
    catch(err){
        console.log(err);
    }
}
const jwtSignGenerator = (payload) => {
    try{
        return jwt.sign(payload,process.env.JWT_SECRET)
    }catch(err){
        console.log(err);
    }
}
const jwtVerify = (token) => {
    let isTokenVerify;
    try{
        isTokenVerify = jwt.verify(token,process.env.JWT_SECRET);
        return isTokenVerify;
    }catch(err){
        isTokenVerify = false;
        return isTokenVerify;
    }
}

const jwtValidateToken = (token) => {
    try{
        jwt.verify(token, 'shhhhh', function(err, decoded) {
            if (err) {
                
              /*
                err = {
                  name: 'TokenExpiredError',
                  message: 'jwt expired',
                  expiredAt: 1408621000
                }
              */
            }
          });
    }catch(err){
        throw new Error(err)
    }
}

module.exports = {
    jwtGenerator,
    jwtSignGenerator,
    jwtVerify,
    jwtValidateToken
}