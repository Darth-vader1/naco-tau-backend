import { supabase } from "../../assets/js/supabase-config.js";

// Initialize Supabase
// const supabase = createClient(...); // Removed duplicate
document.addEventListener('DOMContentLoaded', function() {
  const password = document.getElementById('password');
  const confirm_password = document.getElementById('confirm_password');
  const togglePassword = document.getElementById('toggle-password');
  const toggleConfirmPassword = document.getElementById('toggle-confirm-password');
  togglePassword.addEventListener('click', function (){
    if(password.type === 'password'){
        password.type = 'text';
        document.getElementById('toggle-password').innerHTML = '<i class="bi bi-eye"></i>';
    }else{
        password.type = 'password';
        document.getElementById('toggle-password').innerHTML = '<i class="bi bi-eye-slash"></i>';
    }
  });
  toggleConfirmPassword.addEventListener('click', function (){
    if(confirm_password.type === 'password'){
        confirm_password.type = 'text';
        document.getElementById('toggle-confirm-password').innerHTML = '<i class="bi bi-eye"></i>';
    }else{
        confirm_password.type = 'password';
        document.getElementById('toggle-confirm-password').innerHTML = '<i class="bi bi-eye-slash"></i>';
    }
  })
  document.addEventListener('submit', async function(e) {
    e.preventDefault();
    const studentEmail = document.getElementById('email').value.trim();
    const matricNo = document.getElementById('matric_no').value.trim();
    const firstName = document.getElementById('first_name').value.trim();
    const lastName = document.getElementById('last_name').value.trim();
    const fullName = `${firstName} ${lastName}`;
    const course = document.querySelector('input[name="course"]:checked').value;

    const pass_value = password.value.trim();
    const confirm_pass_value = confirm_password.value.trim(); 
    if (studentEmail.slice(-10) !== "tau.edu.ng"){
      Swal.fire({
        title: "Error!",
        text: "You must signup with your school email!",
        icon: "error",
        confirmButtonText: "Okay",
      });
      return;
    }
    if(pass_value !== confirm_pass_value){
      Swal.fire({
        title: "Error!",
        text: "Passwords do not match",
        icon: "error",
        confirmButtonText: "Okay",
      });
      return;
    }
    if(pass_value.length < 6){
      Swal.fire({
        title: "Error!",
        text: "Your password must be a minimum of 6 characters",
        icon: "error",
        confirmButtonText: "Okay",
      });
      return;
    }
    // console.log(matricNo.toUpperCase().slice(5, 8) !== "MSC")
    if (matricNo.toUpperCase().slice(5, 8) !== "MSS" && matricNo.toUpperCase().slice(5, 8) !== "MSC"){
      Swal.fire({
        title: "Error!",
        text: "Your details do not match that of a computing student. Please contact admin.",
        icon: "error",
        confirmButtonText: "Okay",
      });
      return;
    }
    const signUpStudent = async (email, password, first_name, last_name, matric_no, course) => {
      // Show loading
      Swal.fire({
        title: 'Creating Account...',
        text: 'Please wait while we set up your profile.',
        allowOutsideClick: false,
        didOpen: () => {
          Swal.showLoading()
        }
      });

      try {
        const response = await fetch('/.netlify/functions/signup', {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
          },
          body: JSON.stringify({
            email,
            password,
            first_name,
            last_name,
            matric_number: matric_no,
            department: course
          })
        });

        const result = await response.json();

        if (!response.ok) {
          throw new Error(result.error || 'Signup failed');
        }

        Swal.fire({
          title: "Success!",
          text: "Signup successful! Your account is pending admin approval. Please check back later.",
          icon: "success",
          confirmButtonText: "Okay",
        }).then(() => {
          window.location.href = "student-login.html";
        });

      } catch (error) {
        console.error("Signup error:", error);
        Swal.fire({
          title: "Error!",
          text: error.message || "We're unable to create your account at this time. Please try again later.",
          icon: "error",
          confirmButtonText: "Okay",
        });
      }
    };
    signUpStudent(studentEmail.toLowerCase(), pass_value, firstName, lastName, matricNo.toUpperCase(), course);
  });
});

