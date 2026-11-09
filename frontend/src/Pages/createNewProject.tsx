import * as React from 'react';
import Box from '@mui/material/Box';
import Stepper from '@mui/material/Stepper';
import Step from '@mui/material/Step';
import StepLabel from '@mui/material/StepLabel';
import Button from '@mui/material/Button';
import MainLayout from "../Components/Layout/MainLayout";
import { Stack } from '@mui/material';
import WorkList from '../Components/Core/WorkList';
import TemplateList from '../Components/Core/TemplateList';
import NewProjectDetails from '../Components/Core/NewProjectDetails';
import useAxiosPrivate from "../Hooks/useAxiosPrivate";
import { useContext } from "react";
import { useNavigate } from 'react-router-dom';
import { WSContext } from "../Context/workSpaceContext";
import { PContext } from '../Context/ProjectContext';
import { TemplateContext } from "../Context/TemplateContext";
import DeploymentModel from '../model/deploymentModel'
import ServiceModel from '../model/serviceModel';
import IngressModel from '../model/IngressModel';
import CustomizedSnackbars from '../Components/snackBar/simpleSnackBar'

const steps = ['Select WorkSpace', 'Select Template', 'Enter Project Details'];
const createProject = '/api/v1/project/';
const deploymentURL = '/api/v1/deployments/';
const serviceCreateURL = '/api/v1/service/'
const ingressCreateURL = '/api/v1/ingress/'
export default function CreateNewProject() {

    const seleectedWS = useContext(WSContext);
    const selectedTemplate = useContext(TemplateContext)
    const projectDetails = useContext(PContext)
    const navigate = useNavigate();
    const axiosPrivate = useAxiosPrivate();

    const [activeStep, setActiveStep] = React.useState(0);
    const [skipped, setSkipped] = React.useState(new Set<number>());

    const [errorState, setErrorState] = React.useState(false);
    const [errorMessage, setErrorMessage] = React.useState('');

    const [severity, setSeverity] = React.useState('')

    const setFalseMessage = async () => {
        setErrorState(false);
        setErrorMessage('');
    }
    const isStepSkipped = (step: number) => {
        return skipped.has(step);
    };
    const handleNext = async () => {
        if (activeStep !== steps.length - 1) {
            if (activeStep === 0) {
                let wsid = seleectedWS.wsObject?.workspaceId
                if (wsid === '') {
                    setErrorState(true)
                    setSeverity('error')
                    setErrorMessage('Please Select Atleast One Workspace')
                    return;
                }
            }
            if (activeStep === 1) {
                let tempId = selectedTemplate.templateObject?.templateId
                if (tempId === '') {
                    setErrorState(true)
                    setSeverity('error')
                    setErrorMessage('Please Select Atleast One Template')
                    return;
                }
            }

            let newSkipped = skipped;
            if (isStepSkipped(activeStep)) {
                newSkipped = new Set(newSkipped.values());
                newSkipped.delete(activeStep);
            }
            setActiveStep((prevActiveStep) => prevActiveStep + 1);
            setSkipped(newSkipped);


        }
        else {
            try {
                let projectName = projectDetails.pObject?.projectName
                let projectDescription = projectDetails.pObject?.projectDescription
                if (projectName === '') {
                    setErrorState(true)
                    setSeverity('error')
                    setErrorMessage('Please Enter Project Name')
                    return;

                }
                if (projectDescription === '') {
                    setErrorState(true)
                    setSeverity('error')
                    setErrorMessage('Please Enter Project Description')
                    return;

                }


                let namespaceName = localStorage.getItem('namespaceName')
                let imageName = seleectedWS.wsObject?.imageName
                let frameworkURL = selectedTemplate.templateObject?.gitURL


                const deploymentResponse = await axiosPrivate.post<DeploymentModel>(deploymentURL,
                    JSON.stringify({ namespaceName, imageName, frameworkURL, projectName }),
                    {
                        headers: {
                            'Content-Type': 'application/json'
                        }
                    }
                );
                console.log(deploymentResponse)
                let podSelector = deploymentResponse.data.data.selector
                const serviceResponse = await axiosPrivate.post<ServiceModel>(serviceCreateURL,
                    JSON.stringify({ namespaceName, podSelector, projectName }),
                    {
                        headers: {
                            'Content-Type': 'application/json'
                        }
                    }
                );
                let serviceName = serviceResponse.data.data.serviceName
                const ingressResponse = await axiosPrivate.post<IngressModel>(ingressCreateURL,
                    JSON.stringify({ namespaceName, serviceName, projectName }),
                    {
                        headers: {
                            'Content-Type': 'application/json'
                        }
                    }
                );
                let projectURL = ingressResponse.data.data.projectURL

                let createdBy = localStorage.getItem('_id')
                let updatedBy = localStorage.getItem('_id')
                await axiosPrivate.post<any>(createProject,
                    JSON.stringify({ projectName, projectDescription, createdBy, updatedBy, projectURL }),
                    {
                        headers: {
                            'Content-Type': 'application/json'
                        }
                    }
                );
                navigate('/projects')
            }
            catch (err: any) {
                setErrorState(true)
                setSeverity('error')
                setErrorMessage(err.response.data.error)
            }
        }
    }
    const handleBack = () => {
        setActiveStep((prevActiveStep) => prevActiveStep - 1);
    };
    return (

        <MainLayout>
            {errorState ? <CustomizedSnackbars errorMessage={errorMessage} refresh={errorState} closeError={setFalseMessage} severity={severity} /> : null}
            <Box sx={{ width: '100%', mt: '8vh' }}>
                <Stepper activeStep={activeStep}>
                    {steps.map((label, index) => {
                        const stepProps: { completed?: boolean } = {};
                        const labelProps: {
                            optional?: React.ReactNode;
                        } = {};

                        if (isStepSkipped(index)) {
                            stepProps.completed = false;
                        }
                        return (
                            <Step key={label} {...stepProps}>
                                <StepLabel {...labelProps}>{label}</StepLabel>
                            </Step>
                        );
                    })}
                </Stepper>

                <React.Fragment>
                    {
                        activeStep === 0 &&
                        <WorkList />
                    }
                    {
                        activeStep === 1 &&
                        <TemplateList />
                    }
                    {
                        activeStep === 2 &&
                        <NewProjectDetails />
                    }

                    <Box
                        display="flex"
                        justifyContent="center"
                        alignItems="center">
                        <Stack alignSelf={'center'} m={'auto'} display={'flex'} spacing={2} direction={'row'}>

                            <Button
                                color="inherit"
                                disabled={activeStep === 0}
                                onClick={handleBack}

                            >
                                Back
                            </Button>


                            <Button variant="contained" onClick={handleNext}>
                                {activeStep === steps.length - 1 ? 'Create Project' : 'Next'}
                            </Button>
                        </Stack>
                    </Box>
                </React.Fragment>

            </Box>
        </MainLayout>
    );
};
