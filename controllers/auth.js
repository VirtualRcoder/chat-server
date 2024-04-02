const jwt = require("jsonwebtoken");

const User = require("../models/user");

const crypto = require("crypto");

const mailService = require("../services/mailer");

const otpGenerator = require("otp-generator");

const signToken = (userId) => {
  jwt.sign({ userId }, process.env.JWT_SECRET);
};

const { promisify } = require("util");
const filterObj = require("../utils/filterObj");

//Register new user
exports.register = async (req, res, next) => {
  // const { firstName, lastName, email, password } = req.body;
  const { firstName, lastName, email, password, verified } = req.body;

  const filteredBody = filterObj(
    req.body,
    "firstName",
    "lastName",
    "password",
    "email"
  );
  //check if a verified user if given email address exists
  const exisiting_user = await User.findOne({ email: email });

  if (exisiting_user && exisiting_user.verified) {
    res.status(400).json({
      status: "error",
      messgae: "Email already in use, please login",
    });
  } else if (exisiting_user) {
    await User.findOneAndUpdate({ email: email }, filteredBody, {
      new: true,
      validateModifiedOnly: true,
    });
    req.userId = exisiting_user._id;
    next();
  } else {
    //if user record is not available in DB

    const new_user = await User.create(filteredBody);
    //generate OTP and send email to the user
    req.userId = new_user._id;

    next();
  }
};

exports.sendOTP = async (req, res, next) => {
  const { userId } = req;
  const new_otp = otpGenerator.generate(6, {
    upperCaseAlphabets: false,
    specialChars: false,
    lowerCaseAlphabets: false,
  });

  const otp_expiry_time = Date.now() + 10 * 60 * 1000; // 10 Mins after otp is sent

  const user = await User.findByIdAndUpdate(userId, {
    otp_expiry_time: otp_expiry_time,
  });

  user.otp = new_otp.toString();

  await user.save({ new: true, validateModifiedOnly: true });

  console.log(new_otp);

  // // TODO send mail
  // mailService.sendEmail({
  //   from: "shreyanshshah242@gmail.com",
  //   to: user.email,
  //   subject: "Verification OTP",
  //   html: otp(user.firstName, new_otp),
  //   attachments: [],
  // });

  res.status(200).json({
    status: "success",
    message: "OTP Sent Successfully!",
  });
};

exports.verifyOTP = async (req, res, next) => {
  // verify otp and update user accordingly
  const { email, otp } = req.body;

  const user = await User.findOne({
    email,
    otp_expiry_time: { $gt: Date.now() },
  });

  if (!user) {
    res.status(400).json({
      status: "error",
      message: "email is invalid or OTP expires",
    });
    return;
  }

  if (!(await user.correctOTP(otp, user.otp))) {
    res.status(400).json({
      status: "error",
      message: "OTP is incorrect",
    });
    return;
  }

  //OTP is correct
  user.verified = true;
  user.otp = undefined;

  await user.save({ new: true, validateModifiedOnly: true });

  const token = signToken(user._id);

  res.status(200).json({
    status: "success",
    message: "OTP verified successfully",
    token,
    user_id: user._id,
  });
};

exports.login = async (req, res, next) => {
  const { email, password } = req.body;
  if (!email || !password) {
    res.status(400).json({
      status: "error",
      message: "Both email and password are required",
    });
    return;
  }

  const user = await User.findOne({ email: email }).select("+password");

  if (!user || !(password === user.password)) {
    res.status(400).json({
      status: "error",
      message: "Email or Password is incorrect",
    });
    return;
  }

  const userId = user._id;
  const token = jwt.sign({ userId }, process.env.JWT_SECRET);

  res.status(200).json({
    status: "success",
    message: "Logged in successfully",
    token: token,
    user_id: user._id,
  });
  return;
};

exports.protect = async (req, res, next) => {
  //1) Getting a token (JWT) and check if its actually there

  let token;
  if (
    req.headers.authorization &&
    req.headers.authorization.startsWith("Bearer")
  ) {
    token = req.headers.authorization.split(" ")[1];
  } else if (req.cookies.jwt) {
    token = req.cookies.jwt;
  } else {
    res.status(400).json({
      status: "error",
      message: "You are not logged in!, Please login to get access",
    });

    return;
  }

  //2 Verification of token
  const decoded = await promisify(jwt.verify)(token, process.env.JWT_SECRET);

  //3) Check if user still exist
  const this_user = await User.findById(decoded.userId);

  if (!this_user) {
    res.status(400).json({
      status: "error",
      message: "The user does not exist",
    });
    return;
  }

  //4) check if user change their password after token was issued

  if (this_user.changedPasswordAfter(decoded.iat)) {
    res.status(400).json({
      status: "error",
      message: "User recently changed password! Please login again",
    });
    return;
  }

  //GRANT ACCESS TO PROTECTED ROUTE
  req.user = this_user;
  next();
};

//Types of Routes -> Protected (Only Logged In user can access these) & Unprotected

exports.forgotPassword = async (req, res, next) => {
  //1) Get users email
  const user = await User.findOne({ email: req.body.email });
  if (!user) {
    return res.status(400).json({
      status: "error",
      message: "There is no user with given email address",
    });

    return;
  }

  //2) Generate random reset token
  const resetToken = user.createPasswordResetToken();

  const resetURL = `https://tawk.com/auth/new-password/?code=${resetToken}`;
  // console.log(resetToken);
  try {
    //    TODO => SEND EMAIL
    res.status(200).json({
      status: "success",
      message: "Reset password link sent to email",
    });

    user.passwordResetToken = resetToken;
    user.passwordResetExpires = Date.now() + 10 * 60 * 1000; // 10 Mins after otp is sent

    await user.save({ new: true, validateModifiedOnly: true });
  } catch (error) {
    user.passwordResetToken = undefined;
    user.passwordResetExpires = undefined;
    user.passwordConfirm = undefined;

    await user.save({ validateBeforeSave: false });

    res.status(500).json({
      status: "error",
      message: "There was an error sending the email, Please try again later",
    });
  }
};

exports.resetPassword = async (req, res, next) => {
  //1) Get user based on token
  // const hashedToken = crypto
  // .createHash("sha256")
  // .update(req.body.token)
  // .digest("hex");
  const hashedToken = req.body.token;

  const user = await User.findOne({
    passwordResetToken: hashedToken,
    passwordResetExpires: { $gt: Date.now() },
  });

  //2) If token has expired or submission is out of time window
  console.log(req.body.token);
  console.log(hashedToken);
  if (!user) {
    return res.status(400).json({
      status: "error",
      message: "Token is invalid or expired",
    });
  }

  //3)Update user password and set reset token and expiry to undefined

  user.password = req.body.password;
  user.passwordConfirm = req.body.passwordConfirm;

  user.passwordResetToken = undefined;
  user.passwordResetExpires = undefined;

  await user.save();

  //4) Login user and Send new JWT

  //TODO Send an email to user informing about password change
  const token = signToken(user._id);

  res.status(200).json({
    status: "success",
    message: "Password reset successfully",
    token,
  });
};
